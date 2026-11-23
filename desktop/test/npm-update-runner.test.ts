import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensurePrivateDirectory } from "../../src/core/private-directory.js";
import { resolveWindowsPowerShellPath } from "../../src/core/windows-system-paths.js";
import type { DesktopInstallation } from "../../src/desktop-install/index.js";
import { desktopGlobalPackageSlot } from "../../src/desktop-install/layout.js";
import {
	NpmUpdatePreparationError,
	type NpmUpdatePreparationServices,
	type PreparedNpmUpdate,
	prepareNpmUpdate,
} from "../src/npm-update-runner.js";
import {
	cleanupNpmUpdateDirectory,
	identifyUpdateFile,
	NpmUpdateChannel,
	npmUpdateArguments,
	npmUpdateRequestSchema,
	npmUpdateRetryCommand,
	updateEnvironment,
} from "../src/npm-update-worker.js";
import { updateControlPath } from "../src/update-platform.js";

let suite: string;
let workerPath: string;
const fixtures: string[] = [];
const children: ChildProcess[] = [];
const prepared: PreparedNpmUpdate[] = [];
const rawServers: Server[] = [];

beforeAll(async () => {
	suite = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "qd-ut-")));
	workerPath = join(suite, "standalone-worker.mjs");
	await build({
		entryPoints: [fileURLToPath(new URL("../src/npm-update-worker-entry.ts", import.meta.url))],
		outfile: workerPath,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		logLevel: "silent",
	});
});
afterAll(async () => {
	await rm(suite, { recursive: true, force: true });
});
afterEach(async () => {
	await Promise.all(prepared.splice(0).map((handoff) => handoff.cancel().catch(() => {})));
	await Promise.all(children.splice(0).map(stop));
	await Promise.all(
		rawServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stop(child: ChildProcess): Promise<void> {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
	});
}

function observeWorker(child: ChildProcess): Promise<{ code: number | null; output: string }> {
	children.push(child);
	let output = "";
	const collect = (bytes: Buffer) => {
		output += bytes.toString();
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	child.once("error", (error) => {
		output += error.message;
	});
	return new Promise((resolve) => child.once("close", (code) => resolve({ code, output })));
}

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function fixture(mode = "success", overrides: NodeJS.ProcessEnv = {}) {
	const root = await realpath(await mkdtemp(join(suite, "c'$-")));
	fixtures.push(root);
	const prefix = join(root, "Node's $(unused) `literal` prefix");
	const packageRoot = desktopGlobalPackageSlot(prefix);
	const windows = process.platform === "win32";
	const appPath = windows ? join(root, "Programs", "Quarterdeck") : join(root, "Applications", "Quarterdeck.app");
	const bundledBin = join(appPath, windows ? "host/resources/runtime/bin" : "Contents/Resources/runtime/bin");
	const packageBin = join(packageRoot, "bin");
	const receiptPath = join(root, "managed/managed-installation.json");
	const npmRoot = join(prefix, windows ? "node_modules/npm" : "lib/node_modules/npm");
	const npmPath = join(npmRoot, "bin", "npm-cli.js");
	const bin = windows ? prefix : join(prefix, "bin");
	await Promise.all([
		mkdir(join(packageRoot, "dist"), { recursive: true }),
		mkdir(packageBin, { recursive: true }),
		mkdir(bundledBin, { recursive: true }),
		mkdir(dirname(receiptPath), { recursive: true }),
		mkdir(dirname(npmPath), { recursive: true }),
		mkdir(bin, { recursive: true }),
	]);
	const installation: DesktopInstallation = {
		appPath,
		receiptPath,
		version: "1.0.0",
		arch: process.arch === "arm64" ? "arm64" : "x64",
		source: "release",
		installId: randomUUID(),
		buildId: randomUUID(),
		appAsarSha256: "a".repeat(64),
		cleanupPending: false,
		owner: {
			kind: "npm",
			prefix,
			packageRoot,
			packageSlot: packageRoot,
			identity: {
				schemaVersion: 1,
				version: "1.0.0",
				buildId: randomUUID(),
				sourceSha: "b".repeat(40),
				sourceDirty: false,
			},
		},
	};
	const receipt = {
		schemaVersion: 2,
		managedBy: "quarterdeck-npm",
		installId: installation.installId,
		version: installation.version,
		arch: installation.arch,
		source: installation.source,
		appPath,
		bundleId: "io.github.dankhole.quarterdeck",
		buildId: installation.buildId,
		appAsarSha256: installation.appAsarSha256,
		appTreeSha256: "c".repeat(64),
		desktopLaunchProtocolVersion: 1,
		updatesEnabled: false,
		owner: installation.owner,
		...(windows ? { distributionMode: "windows-unsigned" } : {}),
		signing: windows ? { verified: false, teamId: null } : { verified: true, teamId: "ABCDEFGHIJ" },
		release: {
			manifestSha256: "d".repeat(64),
			containerName: windows ? "synthetic.zip" : "synthetic.dmg",
			containerSha256: "e".repeat(64),
			sourceSha: "b".repeat(40),
		},
	};
	const updated = {
		...installation,
		version: "1.1.0",
		owner: {
			...installation.owner,
			identity: { ...installation.owner.identity, version: "1.1.0", buildId: randomUUID() },
		},
	};
	await Promise.all([
		writeFile(receiptPath, JSON.stringify(receipt)),
		writeFile(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "quarterdeck", version: "1.0.0", type: "module" }),
		),
		writeFile(join(packageRoot, "dist/build-manifest.json"), JSON.stringify(installation.owner.identity)),
		writeFile(
			join(packageRoot, "dist/cli.js"),
			'import {readFileSync} from "node:fs"; if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["desktop","status","--json"])) process.exit(8); await new Promise(resolve => setTimeout(resolve, Number(process.env.TEST_STATUS_DELAY_MS ?? 0))); console.log(readFileSync(process.env.TEST_STATUS, "utf8"));',
		),
		writeFile(join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "11.19.1", type: "module" })),
		writeFile(join(root, "status.json"), JSON.stringify({ state: "ready", pending: false, installation: updated })),
	]);
	await writeFile(
		npmPath,
		`#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
if (process.argv[2] === '--version') { console.log('11.19.1'); process.exit(0); }
writeFileSync(process.env.TEST_TRACE, JSON.stringify({args:process.argv.slice(2),PATH:process.env.PATH,installMode:process.env.QUARTERDECK_INSTALL_MODE,ignoreScripts:process.env.npm_config_ignore_scripts,lockFd:process.env.QUARTERDECK_INSTALLATION_LOCK_FD,nodeOptions:process.env.NODE_OPTIONS,secret:process.env.TEST_SECRET}));
console.log('synthetic npm lifecycle output');
if (process.env.TEST_MODE === 'failure') process.exit(17);
const result=JSON.parse(readFileSync(process.env.TEST_STATUS,'utf8'));
if (process.env.TEST_MODE === 'mismatch' || process.env.npm_config_ignore_scripts === 'true') result.installation.version='1.0.0';
if (process.env.TEST_MODE === 'owner') result.installation.owner.prefix+='/other';
if (process.env.TEST_MODE === 'pending') result.pending=true;
writeFileSync(process.env.TEST_STATUS,JSON.stringify(result));
`,
	);
	await chmod(npmPath, 0o700);
	if (windows) await writeFile(join(bin, "npm.cmd"), "@echo synthetic npm shim");
	else await symlink(npmPath, join(bin, "npm"));
	const node = await realpath(process.execPath);
	const parent = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { PATH: dirname(node) } });
	children.push(parent);
	if (!parent.pid) throw new Error("Synthetic parent did not start.");
	let workerFinished: ReturnType<typeof observeWorker> | undefined;
	let handoffDirectory = "";
	const environment: NodeJS.ProcessEnv = {
		HOME: root,
		USERPROFILE: root,
		PATH: [bin, bundledBin, packageBin, dirname(node), ...(windows ? [] : ["/usr/bin", "/bin"])].join(delimiter),
		TEST_TRACE: join(root, "trace.json"),
		TEST_STATUS: join(root, "status.json"),
		TEST_MODE: mode,
		TEST_SECRET: "synthetic-in-memory-only",
		QUARTERDECK_INSTALLATION_LOCK_FD: "99",
		QUARTERDECK_INSTALLATION_LOCK_PATH: "/synthetic/lock",
		QUARTERDECK_INSTALL_MODE: "browser",
		NODE_OPTIONS: "--require /synthetic/injection.js",
		...overrides,
	};
	const prepare = async (services: NpmUpdatePreparationServices = {}) => {
		const handoff = await prepareNpmUpdate(
			{ installation, targetVersion: "1.1.0", environment, parentPid: parent.pid },
			{
				workerPath,
				temporaryRoot: root,
				readinessTimeoutMs: 5_000,
				authorizationTimeoutMs: 5_000,
				parentExitTimeoutMs: 1_000,
				async launchTerminal(commandPath, nodePath, privateWorker, directory) {
					handoffDirectory = directory;
					const script = await readFile(commandPath, "utf8");
					expect(script).toContain(
						process.platform === "win32" ? "GetEnvironmentVariables" : "exec /usr/bin/env -i",
					);
					expect(script).toContain(nodePath.replaceAll("'", process.platform === "win32" ? "''" : "'\"'\"'"));
					expect(script).not.toContain("synthetic-in-memory-only");
					expect(await readFile(join(directory, "request.json"), "utf8")).not.toContain(
						"synthetic-in-memory-only",
					);
					expect(privateWorker.startsWith(root)).toBe(true);
					const command = windows ? resolveWindowsPowerShellPath() : "/bin/sh";
					const args = windows
						? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", commandPath]
						: [commandPath];
					workerFinished = observeWorker(
						spawn(command, args, {
							stdio: ["ignore", "pipe", "pipe"],
							env: windows ? { SystemRoot: process.env.SystemRoot } : { PATH: "/usr/bin:/bin" },
							cwd: windows ? root : "/",
							windowsHide: true,
						}),
					);
				},
				...services,
			},
		);
		prepared.push(handoff);
		return {
			...handoff,
			async launch() {
				try {
					await handoff.launch();
				} catch (error) {
					if (!workerFinished) throw error;
					const { code, output } = await workerFinished;
					throw new Error(`Synthetic worker closed (${code}) during launch: ${output}`, { cause: error });
				}
			},
		};
	};
	const finished = async () => {
		if (!workerFinished) throw new Error("No synthetic worker was launched.");
		return await workerFinished;
	};
	return {
		root,
		bundledBin,
		packageBin,
		npmPath,
		installation,
		receipt,
		parent,
		environment,
		prepare,
		finished,
		directory: () => handoffDirectory,
		tracePath: join(root, "trace.json"),
	};
}

async function rawWorker(f: Awaited<ReturnType<typeof fixture>>) {
	const directory = await realpath(await mkdtemp(join(f.root, "raw-")));
	await ensurePrivateDirectory(directory);
	const installation = f.installation;
	const request = npmUpdateRequestSchema.parse({
		schemaVersion: 1,
		token: "f".repeat(64),
		createdAt: Date.now(),
		parentPid: f.parent.pid,
		authorizationTimeoutMs: 5_000,
		parentExitTimeoutMs: 1_000,
		verificationTimeoutMs: 5_000,
		targetVersion: "1.1.0",
		node: await identifyUpdateFile(process.execPath),
		npm: await identifyUpdateFile(f.npmPath),
		installation: {
			appPath: installation.appPath,
			receiptPath: installation.receiptPath,
			installId: installation.installId,
			version: installation.version,
			buildId: installation.buildId,
			appAsarSha256: installation.appAsarSha256,
			owner: installation.owner,
		},
	});
	await copyFile(workerPath, join(directory, "worker.mjs"));
	await writeFile(join(directory, "request.json"), JSON.stringify(request), { mode: 0o600 });
	let resolveChannel: (channel: NpmUpdateChannel) => void = () => {};
	const admitted = new Promise<NpmUpdateChannel>((resolve) => {
		resolveChannel = resolve;
	});
	const server = createServer((socket) => resolveChannel(new NpmUpdateChannel(socket)));
	rawServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(updateControlPath(directory), resolve);
	});
	const finished = observeWorker(
		spawn(request.node.path, [join(directory, "worker.mjs"), directory], {
			env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : { PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	const channel = await Promise.race([
		admitted,
		finished.then(({ code, output }) => {
			throw new Error(`Synthetic worker closed (${code}) before connecting: ${output}`);
		}),
	]);
	try {
		expect(await channel.next()).toEqual({ kind: "hello", token: request.token });
		await channel.send({ kind: "environment", environment: f.environment });
		expect(await channel.next()).toEqual({ kind: "ready" });
	} catch (error) {
		channel.socket.destroy();
		const { code, output } = await finished;
		throw new Error(`Synthetic worker closed (${code}) during readiness: ${output}`, { cause: error });
	}
	return { channel, finished, directory };
}

// These process integration tests probe Node/npm and repeatedly hash the real executable.
// Windows additionally starts PowerShell for ACL checks; allow that overhead without
// changing the worker's authorization or parent-exit deadlines.
describe("private npm update handoff", { timeout: process.platform === "win32" ? 45_000 : 15_000 }, () => {
	it.each([undefined, "browser", "desktop"])(
		"explicitly updates the desktop pair with inherited %s install mode",
		(installMode) => {
			expect(
				updateEnvironment({ QUARTERDECK_INSTALL_MODE: installMode }, process.execPath).QUARTERDECK_INSTALL_MODE,
			).toBe("desktop");
			expect(npmUpdateRetryCommand("/synthetic/prefix", "1.1.0")).toBe(
				`${process.platform === "win32" ? "$env:QUARTERDECK_INSTALL_MODE='desktop';" : "QUARTERDECK_INSTALL_MODE=desktop"} npm 'install' '--global' '--prefix' '/synthetic/prefix' '--registry=https://registry.npmjs.org/' '--foreground-scripts' 'quarterdeck@1.1.0'`,
			);
		},
	);
	it("acknowledges readiness, waits for parent exit, updates the exact owning prefix, and removes private files", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		expect(await exists(f.tracePath)).toBe(false);
		await handoff.authorize();
		handoff.commit();
		expect(await exists(f.tracePath)).toBe(false);
		await stop(f.parent);
		expect(await f.finished()).toMatchObject({
			code: 0,
			output: expect.stringContaining("1.1.0 and its desktop app were verified"),
		});
		const trace = JSON.parse(await readFile(f.tracePath, "utf8"));
		expect(trace.args).toEqual(npmUpdateArguments(f.installation.owner.prefix, "1.1.0"));
		expect(trace.installMode).toBe("desktop");
		const paths = trace.PATH.split(delimiter);
		expect(paths[0]).toBe(dirname(await realpath(process.execPath)));
		expect(paths).not.toContain(await realpath(f.bundledBin));
		expect(paths).not.toContain(await realpath(f.packageBin));
		expect(trace.lockFd).toBeUndefined();
		expect(trace.nodeOptions).toBeUndefined();
		expect(trace.secret).toBe("synthetic-in-memory-only");
		await expect(readdir(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["ready", "armed", "committed"])("cancels without npm from %s", async (state) => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		if (state !== "ready") await handoff.authorize();
		if (state === "committed") handoff.commit();
		await handoff.cancel();
		expect(await f.finished()).toMatchObject({ code: 0, output: expect.stringContaining("cancelled") });
		expect(await exists(f.tracePath)).toBe(false);
		await expect(readdir(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses owner changes after shutdown authorization", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		await writeFile(f.installation.receiptPath, JSON.stringify({ ...f.receipt, installId: randomUUID() }));
		await stop(f.parent);
		expect(await f.finished()).toMatchObject({ code: 1, output: expect.stringContaining("owner changed") });
		expect(await exists(f.tracePath)).toBe(false);
	});

	it.each([false, true])("cancels despite a failed cancellation marker, committed=%s", async (committed) => {
		const f = await fixture();
		const handoff = await f.prepare({
			writeCancellationMarker: async () => {
				throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
			},
		});
		await handoff.launch();
		await handoff.authorize();
		if (committed) handoff.commit();
		await handoff.cancel();
		await stop(f.parent);
		expect((await f.finished()).code).toBe(0);
		expect(await exists(f.tracePath)).toBe(false);
		await expect(readdir(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not install when an armed parent exits without a final commit", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		await stop(f.parent);
		expect((await f.finished()).code).toBe(1);
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("does not install when the parent disappears without authorization", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await stop(f.parent);
		expect(await f.finished()).toMatchObject({ code: 1, output: expect.stringContaining("not authorized") });
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("bounds an authorized parent that never exits", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		expect(await f.finished()).toMatchObject({ code: 1, output: expect.stringContaining("did not exit") });
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("cannot install after an authorization ACK is lost before commit", async () => {
		const f = await fixture();
		const worker = await rawWorker(f);
		await worker.channel.send({ kind: "authorize" });
		expect(await worker.channel.next()).toEqual({ kind: "authorized" });
		worker.channel.socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await stop(f.parent);
		expect((await worker.finished).code).toBe(1);
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("allows committed clean shutdown to outlast socket teardown without a 100ms assumption", async () => {
		const f = await fixture();
		const worker = await rawWorker(f);
		await worker.channel.send({ kind: "authorize" });
		expect(await worker.channel.next()).toEqual({ kind: "authorized" });
		await worker.channel.send({ kind: "commit" });
		worker.channel.socket.end();
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(await exists(f.tracePath)).toBe(false);
		await stop(f.parent);
		expect(await worker.finished).toMatchObject({ code: 0, output: expect.stringContaining("were verified") });
	});

	it.each(["failure", "mismatch", "owner", "pending"])(
		"shows visible failure and exact retry guidance for %s",
		async (mode) => {
			const f = await fixture(mode);
			const handoff = await f.prepare();
			await handoff.launch();
			await handoff.authorize();
			handoff.commit();
			await stop(f.parent);
			const result = await f.finished();
			expect(result.code).toBe(1);
			expect(result.output).toContain("synthetic npm lifecycle output");
			expect(result.output).toContain("quarterdeck@1.1.0");
			expect(result.output).toContain("did not complete");
			await expect(readdir(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("preserves ignore-scripts policy and rejects npm exit zero with an old pair", async () => {
		const f = await fixture("success", { npm_config_ignore_scripts: "true" });
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		await stop(f.parent);
		expect((await f.finished()).code).toBe(1);
		expect(JSON.parse(await readFile(f.tracePath, "utf8")).ignoreScripts).toBe("true");
	});

	it.each([
		{ bound: 500, expected: 0 },
		{ bound: 100, expected: 1 },
	])("uses a separate bounded full-pair verification deadline: $bound ms", async ({ bound, expected }) => {
		const f = await fixture("success", { TEST_STATUS_DELAY_MS: "200" });
		const handoff = await f.prepare({ verificationTimeoutMs: bound });
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		await stop(f.parent);
		expect((await f.finished()).code).toBe(expected);
	});

	it("rejects missing external Node/npm and offers a pinned manual command", async () => {
		const f = await fixture("success", { PATH: "/synthetic/missing" });
		await expect(f.prepare()).rejects.toBeInstanceOf(NpmUpdatePreparationError);
		await expect(f.prepare()).rejects.toThrow("quarterdeck@1.1.0");
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("preserves the preparation error cause without exposing it in retry guidance", async () => {
		const f = await fixture();
		const missingWorker = join(f.root, "missing-worker.mjs");
		await expect(f.prepare({ workerPath: missingWorker })).rejects.toMatchObject({
			message: expect.not.stringContaining(missingWorker),
			cause: { code: "ENOENT", path: missingWorker },
		});
	});

	it("rejects a PATH with Node but no npm without consulting a global prefix", async () => {
		const f = await fixture();
		const nodeOnly = join(f.root, "node-only");
		await mkdir(nodeOnly);
		if (process.platform === "win32") await copyFile(process.execPath, join(nodeOnly, "node.exe"));
		else await symlink(process.execPath, join(nodeOnly, "node"));
		f.environment.PATH = nodeOnly;
		await expect(f.prepare()).rejects.toThrow("A usable external npm");
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("does not accept bundled Node as the external update tool", async () => {
		const f = await fixture();
		const nodeName = process.platform === "win32" ? "node.exe" : "node";
		await copyFile(process.execPath, join(f.bundledBin, nodeName));
		f.environment.PATH = f.bundledBin;
		await expect(f.prepare()).rejects.toThrow(`A usable external ${nodeName}`);
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("rejects external Node with a different architecture before preparing a handoff", async () => {
		const f = await fixture();
		f.installation.arch = process.arch === "arm64" ? "x64" : "arm64";
		await expect(f.prepare()).rejects.toThrow("same architecture");
		expect(await exists(f.tracePath)).toBe(false);
		expect(await readdir(f.root)).not.toContain(`quarterdeck-npm-updates-${process.getuid?.() ?? "user"}`);
	});

	it("rejects an npm executable that changes while Quarterdeck shuts down", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		await writeFile(f.npmPath, `${await readFile(f.npmPath, "utf8")}\n// changed\n`);
		await stop(f.parent);
		expect(await f.finished()).toMatchObject({ code: 1, output: expect.stringContaining("Node or npm changed") });
		expect(await exists(f.tracePath)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"refuses an overlong private socket path and cleans the allocation",
		async () => {
			const f = await fixture();
			const longRoot = join(f.root, "long-temporary-root-".repeat(5));
			await mkdir(longRoot);
			await expect(f.prepare({ temporaryRoot: longRoot })).rejects.toBeInstanceOf(NpmUpdatePreparationError);
			expect(await readdir(join(longRoot, `quarterdeck-npm-updates-${process.getuid?.() ?? "user"}`))).toEqual([]);
		},
	);

	it("requires readiness before shutdown and removes a never-started Terminal handoff", async () => {
		const f = await fixture();
		const handoff = await f.prepare({ readinessTimeoutMs: 100, launchTerminal: async () => {} });
		await expect(handoff.authorize()).rejects.toThrow("not ready");
		await expect(handoff.launch()).rejects.toThrow("did not acknowledge");
		expect(await exists(f.tracePath)).toBe(false);
		expect(await readdir(join(f.root, `quarterdeck-npm-updates-${process.getuid?.() ?? "user"}`))).toEqual([]);
	});

	it("bounds abandoned handoffs and reports their exact inspection directory", async () => {
		const f = await fixture();
		const root = join(f.root, `quarterdeck-npm-updates-${process.getuid?.() ?? "user"}`);
		await ensurePrivateDirectory(root);
		await Promise.all([0, 1, 2, 3].map((index) => mkdir(join(root, `retained-${index}`))));
		await expect(f.prepare()).rejects.toThrow(`Four update handoffs remain in ${root}`);
		expect((await readdir(root)).length).toBe(4);
	});

	it("retains unrecognized files during conservative cleanup", async () => {
		const root = await realpath(await mkdtemp(join(suite, "unknown-")));
		await ensurePrivateDirectory(root);
		await writeFile(join(root, "unrecognized"), "keep");
		await expect(cleanupNpmUpdateDirectory(root)).rejects.toThrow("Unrecognized");
		expect(await readFile(join(root, "unrecognized"), "utf8")).toBe("keep");
	});
});
