import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { installSyntheticDesktopNativeAdmission } from "../desktop/scripts/native-admission.mjs";

// Native boundary experiment, deliberately separate from the Quarterdeck Agent
// Lab's product/receipt checks. Only a copied app is changed. No production home,
// Dock, provider, keychain, network content, or existing app instance is used.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(join(repoRoot, "desktop", "package.json"));
const roles = ["renderer", "gpu", "utility", "plugin", "crashpad", "node"];

function command(executable, args, options = {}) {
	const result = spawnSync(executable, args, { encoding: "utf8", timeout: 30_000, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${executable} exited ${result.status}: ${result.stderr}`);
	return result.stdout;
}

async function hash(path) {
	const digest = createHash("sha256");
	for await (const bytes of createReadStream(path)) digest.update(bytes);
	return digest.digest("hex");
}

async function json(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function eventually(read, accept, description, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	let value;
	do {
		value = await read();
		if (accept(value)) return value;
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error(`Timed out: ${description}; last value ${JSON.stringify(value)}`);
}

const witnessSource = String.raw`
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 2) return 64;
    int size = proc_listallpids(NULL, 0);
    if (size <= 0) return 74;
    pid_t *pids = calloc((size_t)size + 1024, sizeof(pid_t));
    if (!pids) return 74;
    int count = proc_listallpids(pids, (size + 1024) * (int)sizeof(pid_t));
    for (int i = 0; i < count; i++) {
        char path[PROC_PIDPATHINFO_MAXSIZE];
        struct proc_bsdinfo process;
        struct vnode_fdinfowithpath fd;
        memset(&fd, 0, sizeof(fd));
        if (proc_pidpath(pids[i], path, sizeof(path)) <= 0 ||
            strncmp(path, argv[1], strlen(argv[1])) || path[strlen(argv[1])] != '/' ||
            proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &process, sizeof(process)) != sizeof(process)) continue;
        int result = proc_pidfdinfo(pids[i], 198, PROC_PIDFDVNODEPATHINFO, &fd, sizeof(fd));
        printf("%d\t%u\t%u\t%llu\t%llu\t%d\t%u\t%llu\t%u\t%s\t%s\n",
            pids[i], process.pbi_ppid, process.pbi_uid,
            process.pbi_start_tvsec, process.pbi_start_tvusec, result,
            fd.pvip.vip_vi.vi_stat.vst_dev, fd.pvip.vip_vi.vi_stat.vst_ino,
            fd.pvip.vip_vi.vi_stat.vst_mode, path, result > 0 ? fd.pvip.vip_path : "");
    }
    free(pids);
    return 0;
}
`;

const probeMain = String.raw`
const { app, BrowserWindow, crashReporter, utilityProcess } = require('electron');
const { spawn } = require('node:child_process');
const { appendFileSync, fstatSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const root = process.env.QUARTERDECK_ADMISSION_PROBE_ROOT;
function descriptor() { try { const s = fstatSync(198); return {dev:s.dev,ino:s.ino}; } catch {return null;} }
app.setPath('userData', join(root, 'profile'));
app.commandLine.appendSwitch('use-mock-keychain');
crashReporter.start({productName:'Quarterdeck admission probe',uploadToServer:false,submitURL:'http://127.0.0.1:1',ignoreSystemCrashHandler:true});
let window;
const children=[];
app.on('child-process-gone',(_event,details)=>appendFileSync(join(root,'child-exits.jsonl'),JSON.stringify(details)+'\n'));
app.whenReady().then(async () => {
  const node = spawn(join(process.resourcesPath,'runtime','bin','node'),[join(__dirname,'child.cjs'),'node'],{stdio:'ignore',env:process.env});
  const utility = utilityProcess.fork(join(__dirname,'child.cjs'),['utility'],{stdio:'ignore',serviceName:'Admission utility'});
  const plugin = utilityProcess.fork(join(__dirname,'child.cjs'),['plugin'],{stdio:'ignore',serviceName:'Admission plugin',allowLoadingUnsignedLibraries:true});
  children.push(node,utility,plugin);
  window = new BrowserWindow({show:false,webPreferences:{sandbox:true}});
  await window.loadURL('data:text/html,<title>Admission probe</title><canvas id="c"></canvas><script>c.getContext("webgl");</script>');
  setInterval(() => {
    const ready={main:process.pid,mainDescriptor:descriptor(),renderer:window.webContents.getOSProcessId(),node:node.pid,utility:utility.pid,plugin:plugin.pid,metrics:app.getAppMetrics()};
    writeFileSync(join(root,'ready.json'), JSON.stringify(ready));
    appendFileSync(join(root,'metrics.jsonl'),JSON.stringify(ready)+'\n');
    if (existsSync(join(root,'quit'))) app.quit();
  },100);
});
`;

const probeChild = String.raw`
const { fstatSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const role = process.argv[process.argv.length-1];
let descriptor;
try {const s=fstatSync(198);descriptor={dev:s.dev,ino:s.ino};}catch {descriptor=null;}
writeFileSync(join(process.env.QUARTERDECK_ADMISSION_PROBE_ROOT,role+'.json'),JSON.stringify({pid:process.pid,execPath:process.execPath,descriptor}));
setInterval(()=>{},1000);
`;

async function renameElectronFixture(appPath) {
	const contents = join(appPath, "Contents");
	await rename(join(contents, "MacOS", "Electron"), join(contents, "MacOS", "Quarterdeck"));
	for (const suffix of ["", " (GPU)", " (Renderer)", " (Plugin)"]) {
		const previous = `Electron Helper${suffix}`;
		const name = `Quarterdeck Helper${suffix}`;
		const helper = join(contents, "Frameworks", `${name}.app`);
		await rename(join(contents, "Frameworks", `${previous}.app`), helper);
		await rename(join(helper, "Contents", "MacOS", previous), join(helper, "Contents", "MacOS", name));
		command("/usr/bin/plutil", [
			"-replace",
			"CFBundleExecutable",
			"-string",
			name,
			join(helper, "Contents", "Info.plist"),
		]);
	}
	for (const key of ["CFBundleExecutable", "CFBundleName", "CFBundleDisplayName"]) {
		command("/usr/bin/plutil", ["-replace", key, "-string", "Quarterdeck", join(contents, "Info.plist")]);
	}
}

async function prepare(source, electronFixture, runRoot, nodeSource) {
	const home = join(runRoot, "home");
	const appPath = join(home, "Applications", "Quarterdeck.app");
	const lockPath = join(home, "Library", "Application Support", "Quarterdeck", "installation", "admission.lock");
	await mkdir(dirname(appPath), { recursive: true, mode: 0o700 });
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	command("/usr/bin/ditto", [source, appPath]);
	if (electronFixture) await renameElectronFixture(appPath);
	const resources = join(appPath, "Contents", "Resources");
	// Refuse a copied framework symlink that could mutate the source candidate.
	for (const path of [
		resources,
		join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"),
	])
		assert((await realpath(path)).startsWith(`${appPath}/`), "Copied app path escapes fixture");
	const runtime = join(resources, "runtime");
	await mkdir(join(runtime, "bin"), { recursive: true });
	if (electronFixture) {
		await copyFile(nodeSource, join(runtime, "bin", "node"));
		await chmod(join(runtime, "bin", "node"), 0o755);
	}
	const host = join(appPath, "Contents", "MacOS", "QuarterdeckHost");
	const main = join(appPath, "Contents", "MacOS", "Quarterdeck");
	const originalHost = await stat(host).then(
		() => host,
		() => main,
	);
	const identity = {
		source,
		electronFixture,
		mainHostSha256: await hash(originalHost),
		nodeHostSha256: await hash(join(runtime, "bin", electronFixture ? "node" : "nodeHost")),
		frameworkSha256: await hash(
			join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"),
		),
		nativeSourceSha256: await hash(join(repoRoot, "desktop", "native", "installation-admission.c")),
		nativeUtilitySha256: await hash(join(repoRoot, "desktop", "scripts", "native-admission.mjs")),
		architecture: process.arch,
		macOS: command("/usr/bin/sw_vers", ["-productVersion"]).trim(),
	};
	if (!electronFixture)
		identity.sourceBundleManifest = JSON.parse(await readFile(join(runtime, "bundle-manifest.json"), "utf8"));
	// The copied JS payload is only a native admission probe. Retain/record the
	// source host identities; this is not evidence of product pairing or signing.
	const { flipFuses, FuseVersion, FuseV1Options } = requireDesktop("@electron/fuses");
	await flipFuses(appPath, {
		version: FuseVersion.V1,
		[FuseV1Options.OnlyLoadAppFromAsar]: false,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
	});
	await rm(join(resources, "app.asar"), { force: true });
	await rm(join(resources, "app"), { recursive: true, force: true });
	await mkdir(join(resources, "app"));
	await json(join(resources, "app", "package.json"), {
		name: "quarterdeck-native-admission-probe",
		version: "0.0.0",
		main: "main.cjs",
	});
	await writeFile(join(resources, "app", "main.cjs"), probeMain);
	await writeFile(join(resources, "app", "child.cjs"), probeChild);
	await installSyntheticDesktopNativeAdmission(appPath, home);
	assert.equal(
		await hash(join(repoRoot, "desktop", "native", "installation-admission.c")),
		identity.nativeSourceSha256,
		"Native source changed during fixture compilation",
	);
	// Modified synthetic copies only. No security/signature claim is made.
	command("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
	const witness = join(runRoot, "process-witness");
	await writeFile(`${witness}.c`, witnessSource);
	command("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", `${witness}.c`, "-o", witness]);
	return { home, appPath, lockPath, main, witness, bootstrap: join(runtime, "installation-admission"), identity };
}

function snapshot(fixture) {
	return command(fixture.witness, [fixture.appPath])
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [pid, ppid, uid, seconds, microseconds, fdResult, dev, ino, mode, executable, lock] = line.split("\t");
			return {
				pid: Number(pid),
				ppid: Number(ppid),
				uid: Number(uid),
				birth: `${seconds}.${microseconds}`,
				fdResult: Number(fdResult),
				dev,
				ino,
				mode: Number(mode),
				executable,
				lock,
			};
		});
}

function signal(fixture, process, name) {
	const current = snapshot(fixture).find(
		(entry) => entry.pid === process.pid && entry.birth === process.birth && entry.uid === process.uid,
	);
	if (current) globalThis.process.kill(current.pid, name);
}

async function drain(fixture, except) {
	await eventually(
		() => {
			const entries = snapshot(fixture).filter(
				(entry) => !except || entry.pid !== except.pid || entry.birth !== except.birth,
			);
			for (const entry of entries) signal(fixture, entry, "SIGKILL");
			return snapshot(fixture).filter(
				(entry) => !except || entry.pid !== except.pid || entry.birth !== except.birth,
			);
		},
		(entries) => entries.length === 0,
		"owned app processes drain",
		10_000,
	);
}

async function exclusive(fixture) {
	const child = spawn(fixture.bootstrap, ["--quarterdeck-install-lock", fixture.lockPath], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	let error = "";
	child.stdout.on("data", (bytes) => {
		output += bytes;
		if (output.includes("QUARTERDECK_INSTALLATION_LOCK_READY")) child.stdin.end();
	});
	child.stderr.on("data", (bytes) => {
		error += bytes;
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
	try {
		return await new Promise((resolveResult, reject) => {
			child.once("error", reject);
			child.once("close", (code, signalName) => resolveResult({ code, signal: signalName, output, error }));
		});
	} finally {
		clearTimeout(timer);
	}
}

async function launchWhileExclusive(fixture, runRoot) {
	const holder = spawn(fixture.bootstrap, ["--quarterdeck-install-lock", fixture.lockPath], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	let error = "";
	holder.stdout.on("data", (bytes) => {
		output += bytes;
	});
	holder.stderr.on("data", (bytes) => {
		error += bytes;
	});
	const closed = new Promise((resolveResult, reject) => {
		holder.once("error", reject);
		holder.once("close", (code) => resolveResult(code));
	});
	const results = [];
	try {
		await eventually(
			() => output,
			(value) => value.includes("QUARTERDECK_INSTALLATION_LOCK_READY"),
			"EX holder readiness",
			30_000,
		);
		const entries = [
			"Contents/MacOS/Quarterdeck",
			"Contents/Resources/runtime/bin/node",
			...["", " (GPU)", " (Renderer)", " (Plugin)", " (Utility)"].map(
				(suffix) =>
					`Contents/Frameworks/Quarterdeck Helper${suffix}.app/Contents/MacOS/Quarterdeck Helper${suffix}`,
			),
			"Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
		];
		for (const relative of entries) {
			const executable = join(fixture.appPath, relative);
			if (
				!(await stat(executable).then(
					() => true,
					() => false,
				))
			) {
				results.push({ relative, present: false });
				continue;
			}
			const result = spawnSync(executable, ["--version"], {
				encoding: "utf8",
				timeout: 15_000,
				env: { PATH: process.env.PATH, HOME: fixture.home },
			});
			results.push({
				relative,
				present: true,
				code: result.status,
				signal: result.signal,
				stdout: result.stdout,
				stderr: result.stderr,
			});
			assert.equal(result.status, 73, `${relative} must refuse before host loading while EX held`);
			assert.equal(result.stdout, "", `${relative} must not run its host`);
		}
		assert.equal(
			snapshot(fixture).filter((entry) => entry.pid !== holder.pid).length,
			0,
			"EX refusal must leave no bundle consumer",
		);
		return { role: "all-present-entry-points", passed: true, results };
	} finally {
		holder.stdin.end();
		await eventually(
			() => holder.exitCode,
			(value) => value !== null,
			"EX holder shutdown",
			3_000,
		).catch(() => holder.kill("SIGKILL"));
		await closed;
		await json(join(runRoot, "exclusive-launches.json"), { output, error, results });
	}
}

function assertAdmission(entry, lock) {
	assert(entry.fdResult > 0, `PID ${entry.pid} (${entry.executable}) has no inspectable fd198`);
	assert.equal(entry.dev, String(lock.dev), `PID ${entry.pid} lock device`);
	assert.equal(entry.ino, String(lock.ino), `PID ${entry.pid} lock inode`);
	assert.equal(entry.mode & 0o077, 0, `PID ${entry.pid} private lock`);
}

async function launch(fixture, scenarioRoot) {
	await mkdir(scenarioRoot);
	const environment = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("QUARTERDECK_") &&
				!["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"].includes(key),
		),
	);
	Object.assign(environment, {
		HOME: fixture.home,
		USERPROFILE: fixture.home,
		TMPDIR: scenarioRoot,
		QUARTERDECK_ADMISSION_PROBE_ROOT: scenarioRoot,
	});
	const child = spawn(fixture.main, ["--use-mock-keychain", `--user-data-dir=${join(scenarioRoot, "profile")}`], {
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const logs = [];
	child.stdout.on("data", (bytes) => logs.push(bytes));
	child.stderr.on("data", (bytes) => logs.push(bytes));
	child.once("error", (error) => logs.push(Buffer.from(String(error))));
	try {
		const ready = await eventually(
			async () => {
				try {
					return JSON.parse(await readFile(join(scenarioRoot, "ready.json"), "utf8"));
				} catch {
					return null;
				}
			},
			(value) => value?.node && value.utility && value.plugin && value.renderer,
			"probe readiness",
		);
		const entries = await eventually(
			() => snapshot(fixture),
			(value) => value.some((entry) => entry.executable.includes("crashpad_handler")),
			"crashpad startup",
		);
		const lock = await stat(fixture.lockPath);
		await json(join(scenarioRoot, "startup.json"), {
			ready,
			lock: { dev: lock.dev, ino: lock.ino },
			processes: entries,
		});
		for (const entry of entries) assertAdmission(entry, lock);
		return { ready, entries, lock, child };
	} finally {
		await writeFile(join(scenarioRoot, "electron.log"), Buffer.concat(logs));
	}
}

function selectRole(role, started) {
	if (role === "gpu") {
		const pid = started.ready.metrics.find((entry) => entry.type === "GPU")?.pid;
		return started.entries.find((entry) => entry.pid === pid);
	}
	if (role === "crashpad") return started.entries.find((entry) => entry.executable.includes("crashpad_handler"));
	return started.entries.find((entry) => entry.pid === started.ready[role]);
}

async function survivor(fixture, runRoot, role, normalQuit = false) {
	const scenarioRoot = join(runRoot, `${normalQuit ? "normal-quit" : "main-loss"}-${role}`);
	try {
		const started = await launch(fixture, scenarioRoot);
		const selected = selectRole(role, started);
		assert(selected, `No live ${role} process`);
		signal(fixture, selected, "SIGSTOP");
		if (normalQuit) {
			await writeFile(join(scenarioRoot, "quit"), "quit\n");
			await eventually(
				() => snapshot(fixture),
				(entries) => !entries.some((entry) => entry.pid === started.ready.main),
				"normal main exit",
			);
		} else {
			const main = started.entries.find((entry) => entry.pid === started.ready.main);
			assert(main);
			signal(fixture, main, "SIGKILL");
		}
		await drain(fixture, selected);
		const sole = snapshot(fixture);
		assert.equal(sole.length, 1, "survivor must be the only remaining bundle process");
		assert.equal(sole[0].birth, selected.birth);
		assertAdmission(sole[0], started.lock);
		const denied = await exclusive(fixture);
		assert.equal(denied.code, 73, "EX mutation must refuse while sole child survives");
		await json(join(scenarioRoot, "sole-survivor.json"), { role, normalQuit, processes: sole, exclusive: denied });
		signal(fixture, selected, "SIGKILL");
		await drain(fixture);
		const admitted = await exclusive(fixture);
		assert.equal(admitted.code, 0, "EX mutation must succeed after the last child exits");
		await json(join(scenarioRoot, "drained.json"), { processes: snapshot(fixture), exclusive: admitted });
		return { role, normalQuit, passed: true, survivorPid: selected.pid, executable: selected.executable };
	} finally {
		await drain(fixture);
	}
}

export async function runNativeAdmissionSmoke({ appPath, electronFixture = false, nodePath = process.execPath }) {
	assert.equal(process.platform, "darwin", "Native admission proof requires macOS");
	// Match the Agent Lab's preflight: restricted AppKit/process inspection must
	// fail before any GUI executable is started.
	command("/bin/ps", ["-p", String(process.pid), "-o", "pid=,lstart=,command="]);
	const source = await realpath(resolve(appPath));
	assert(source.endsWith(".app"), "Expected a packaged .app");
	const artifactRoot = join(repoRoot, ".cache", "test-results");
	await mkdir(artifactRoot, { recursive: true });
	const runRoot = await mkdtemp(join(artifactRoot, "native-admission-"));
	const report = {
		schemaVersion: 1,
		runRoot,
		source,
		startedAt: new Date().toISOString(),
		status: "running",
		scenarios: [],
		limitations: [
			"Synthetic compile-time home and ad hoc signature; no signed/Gatekeeper or real Dock claim.",
			"Copied application JS is a local native-boundary probe; normal Quarterdeck behavior and installation pairing require the separate packaged Agent Lab.",
			"Frozen child survivors make each executable's independent bundle-use lock observable; they do not represent normal shutdown timing.",
			"Inactive Squirrel ShipIt is not launched; framework libraries are not executable entry points.",
		],
	};
	let fixture;
	try {
		fixture = await prepare(source, electronFixture, runRoot, await realpath(nodePath));
		report.identity = fixture.identity;
		report.scenarios.push(await launchWhileExclusive(fixture, runRoot));
		for (const role of roles) {
			report.scenarios.push(await survivor(fixture, runRoot, role));
			await json(join(runRoot, "report.json"), report);
		}
		report.scenarios.push(await survivor(fixture, runRoot, "node", true));
		report.status = "passed";
	} catch (error) {
		report.status = "failed";
		report.failure = error instanceof Error ? error.stack : String(error);
	} finally {
		if (fixture) {
			try {
				await drain(fixture);
			} catch (error) {
				report.cleanupFailure = String(error);
				report.status = "failed";
			}
			report.remainingProcesses = snapshot(fixture);
		}
		report.finishedAt = new Date().toISOString();
		await json(join(runRoot, "report.json"), report);
	}
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const flag = args[0];
	if (!["--app", "--electron"].includes(flag) || !args[1] || args.length > 2) {
		console.error(
			"Usage: node scripts/native-admission-smoke.mjs --app /path/to/Quarterdeck.app\n       node scripts/native-admission-smoke.mjs --electron /path/to/Electron.app",
		);
		process.exitCode = 64;
	} else {
		const report = await runNativeAdmissionSmoke({ appPath: args[1], electronFixture: flag === "--electron" });
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.status === "passed" ? 0 : 1;
	}
}
