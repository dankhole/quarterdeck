import { type ChildProcess, execFile, spawn } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listWindowsDesktopProcesses } from "../../scripts/agent-lab/desktop-windows-processes.js";
import { ensurePrivateDirectory } from "../../src/core/private-directory.js";
import { resolveWindowsSystem32ExecutablePath } from "../../src/core/windows-system-paths.js";
import { acquireDesktopMutation } from "../../src/desktop-install/admission.js";

const execute = promisify(execFile);
let root: string;
let executable: string;
let production: string;
interface Lease {
	handle: string;
	birth: string;
}
async function acquire(lock: string): Promise<Lease> {
	const { stdout } = await execute(executable, ["--quarterdeck-acquire-mutation", lock], {
		timeout: 10000,
		windowsHide: true,
	});
	return JSON.parse(stdout) as Lease;
}
async function release(lock: string, lease: Lease) {
	await execute(executable, ["--quarterdeck-release-mutation", lock, lease.handle, lease.birth], {
		timeout: 10000,
		windowsHide: true,
	});
}
async function expectBusy(lock: string, diagnostic?: string): Promise<void> {
	let unexpected: Lease;
	try {
		unexpected = await acquire(lock);
	} catch (error) {
		if (diagnostic) {
			expect(error).toMatchObject({ code: 73, stderr: expect.stringContaining(diagnostic) });
		} else {
			expect([73, 74]).toContain((error as { code: unknown }).code);
		}
		return;
	}
	await release(lock, unexpected);
	throw new Error("Native mutation admission unexpectedly succeeded.");
}
async function simulateNewBoot(lock: string): Promise<void> {
	// Only a synthetic fixture is edited. Production recovery reads the kernel boot GUID.
	for (const name of await readdir(dirname(lock))) {
		if (!name.startsWith(`${basename(lock)}.launch-`)) continue;
		const path = join(dirname(lock), name);
		const marker = await readFile(path);
		marker[8] = (marker[8] ?? 0) ^ 0xff;
		await writeFile(path, marker);
	}
}
function ready(child: ChildProcess): Promise<void> {
	return new Promise((accept, reject) => {
		let output = "",
			stderr = "";
		const timer = setTimeout(() => reject(new Error(`Native fixture did not become ready: ${stderr}`)), 10000);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("HELPER_READY")) {
				clearTimeout(timer);
				accept();
			}
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			if (!output.includes("HELPER_READY")) {
				clearTimeout(timer);
				reject(new Error(`Native fixture exited ${code}: ${output}${stderr}`));
			}
		});
	});
}

describe.skipIf(process.platform !== "win32")("native Windows installation admission", () => {
	beforeAll(async () => {
		const parent = resolve("desktop/.cache/test-results");
		await mkdir(parent, { recursive: true });
		root = await mkdtemp(join(parent, "windows admission 项目-"));
		await ensurePrivateDirectory(root);
		executable = join(root, "admission.exe");
		await execute(
			process.execPath,
			[resolve("desktop/scripts/windows-native-admission.mjs"), "--output", executable, "--test"],
			{ timeout: 120000, windowsHide: true },
		);
		production = join(root, "production.exe");
		await execute(
			process.execPath,
			[resolve("desktop/scripts/windows-native-admission.mjs"), "--output", production],
			{ timeout: 120000, windowsHide: true },
		);
	}, 130000);
	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});
	it("retains exclusive admission in the installer after its native helper has exited", async () => {
		const lock = join(root, "mutation.lock");
		const lease = await acquire(lock);
		try {
			await expect(rm(lock)).rejects.toThrow();
			await expectBusy(lock);
			await expect(release(lock, { ...lease, birth: "1" })).rejects.toThrow();
			await expectBusy(lock);
		} finally {
			await release(lock, lease);
		}
		await release(lock, await acquire(lock));
	});
	it("releases through the shared API after the source helper is moved or removed", async () => {
		const source = join(root, "source-helper.exe");
		const moved = join(root, "moved-helper.exe");
		await copyFile(executable, source);
		const lock = join(root, "shared-api.lock");
		const releaseLease = await acquireDesktopMutation(source, lock);
		try {
			await rename(source, moved);
			await rm(moved);
			await expectBusy(lock);
		} finally {
			const first = releaseLease();
			expect(releaseLease()).toBe(first);
			await first;
		}
		await releaseLease();
		await release(lock, await acquire(lock));
		expect((await readdir(root)).filter((name) => name.startsWith(".mutation-"))).toEqual([]);
	});
	it("inherits a real CRT descriptor and preserves quoted Unicode and backslash arguments", async () => {
		const lock = join(root, "arguments.lock");
		const expected = ["a b", 'quote"value', "D:\\项目\\trailing\\", "$(literal) %PATH% & text", ""];
		const script = "require('node:fs').fstatSync(198); console.log(JSON.stringify(process.argv.slice(1)));";
		const { stdout } = await execute(
			executable,
			["--quarterdeck-test-exec", lock, process.execPath, "-e", script, ...expected],
			{ timeout: 10000, windowsHide: true },
		);
		expect(JSON.parse(stdout)).toEqual(expected);
	});
	it("exposes inherited admission through the production descriptor validator", async () => {
		const lock = join(root, "descriptor.lock");
		const module = pathToFileURL(resolve("src/desktop-install/admission.ts")).href;
		const script = `import {getDesktopAdmissionDescriptor} from ${JSON.stringify(module)}; console.log(JSON.stringify(getDesktopAdmissionDescriptor()));`;
		const { stdout } = await execute(
			executable,
			["--quarterdeck-test-exec", lock, process.execPath, "--import", "tsx", "--input-type=module", "-e", script],
			{ timeout: 10000, windowsHide: true },
		);
		expect(JSON.parse(stdout)).toEqual({ fd: 198, path: lock });
	});
	it("keeps arbitrary lock paths and synthetic launch commands out of the production helper", async () => {
		await expect(
			execute(production, ["--quarterdeck-acquire-mutation", join(root, "foreign.lock")], {
				timeout: 10000,
				windowsHide: true,
			}),
		).rejects.toMatchObject({ code: 73 });
		await expect(
			execute(production, ["--quarterdeck-test-exec", join(root, "foreign.lock"), process.execPath, "--version"], {
				timeout: 10000,
				windowsHide: true,
			}),
		).rejects.toMatchObject({ code: 73 });
	});
	it("preserves the private Node IPC channel through native admission", async () => {
		const lock = join(root, "ipc.lock");
		const script = "process.send({admitted:require('node:fs').fstatSync(198).isFile()});process.disconnect();";
		const child = spawn(executable, ["--quarterdeck-test-exec", lock, process.execPath, "-e", script], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			windowsHide: true,
		});
		const closed = new Promise<void>((accept) => child.once("close", () => accept()));
		try {
			const message = await new Promise<unknown>((accept, reject) => {
				let stderr = "";
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const timer = setTimeout(
					() => reject(new Error(`Admitted Node IPC channel did not respond: ${stderr}`)),
					5000,
				);
				child.once("message", (value) => {
					clearTimeout(timer);
					accept(value);
				});
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("close", (code) => {
					clearTimeout(timer);
					reject(new Error(`Admitted IPC child exited ${code} before sending a message: ${stderr}`));
				});
			});
			expect(message).toEqual({ admitted: true });
			await closed;
			expect(child.exitCode).toBe(0);
		} finally {
			child.kill();
			await closed;
		}
	});
	it.each([false, true])(
		"protects surviving inherited helpers after launcher exit (killed=%s)",
		async (killLauncher) => {
			const lock = join(root, `survivor-${killLauncher}.lock`);
			const helper =
				"require('node:fs').fstatSync(4); console.log('HELPER_READY'); setTimeout(()=>process.exit(0),1500);";
			const main = `require('node:fs').fstatSync(198); const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit','ignore',198],windowsHide:true,detached:true}); c.unref(); setTimeout(()=>process.exit(0),200);`;
			const child = spawn(executable, ["--quarterdeck-test-exec", lock, process.execPath, "-e", main], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const exited = new Promise<void>((accept) => child.once("exit", () => accept()));
			const closed = new Promise<void>((accept) => child.once("close", () => accept()));
			try {
				await ready(child);
				if (killLauncher) child.kill();
				await expectBusy(lock);
				await exited;
				await closed;
				if (killLauncher) {
					await expectBusy(lock);
					await simulateNewBoot(lock);
				}
				await release(lock, await acquire(lock));
			} finally {
				child.kill();
				await closed;
			}
		},
	);
	it.each([false, true])("protects descriptor-free native descendants (monitor killed=%s)", async (killMonitor) => {
		const lock = join(root, `raw-descendant-${killMonitor}.lock`);
		const helper = "setTimeout(()=>process.exit(0),1200)";
		const main = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore',detached:true,windowsHide:true});c.unref(); console.log('HELPER_READY');setTimeout(()=>process.exit(0),100);`;
		const child = spawn(executable, ["--quarterdeck-test-exec", lock, process.execPath, "-e", main], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const exited = new Promise<void>((accept) => child.once("exit", () => accept()));
		try {
			await ready(child);
			if (killMonitor) child.kill();
			await new Promise((accept) => setTimeout(accept, 300));
			await expectBusy(lock);
			await exited;
			if (killMonitor) {
				await new Promise((accept) => setTimeout(accept, 1300));
				await expectBusy(lock);
				await simulateNewBoot(lock);
			}
			await release(lock, await acquire(lock));
		} finally {
			child.kill();
			await exited;
		}
	});
	it("refuses a reparse-point ancestor and an unprotected metadata directory", async () => {
		const actual = join(root, "actual");
		await ensurePrivateDirectory(actual);
		const alias = join(root, "alias");
		await symlink(actual, alias, "junction");
		await expect(acquireDesktopMutation(executable, join(alias, "admission.lock"))).rejects.toMatchObject({
			code: "installation_changed",
		});
		await expectBusy(join(alias, "admission.lock"), "parent directory: reparse point refused");
		// An unprotected parent outside the protected fixture has inherited broad access.
		const outside = await mkdtemp(join(resolve("desktop/.cache"), "unprotected-admission-"));
		try {
			await expectBusy(join(outside, "admission.lock"), "protected metadata directory:");
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
	it("refuses hard-linked lock files", async () => {
		const lock = join(root, "linked.lock");
		await writeFile(lock, "");
		await link(lock, join(root, "second-link.lock"));
		await expectBusy(lock, "installation lock: not a regular single-link file");
	});
	it("refuses an Administrators access grant even inside protected metadata", async () => {
		const lock = join(root, "administrators-access.lock");
		// Prove the parent and initial lock pass admission before changing the DACL.
		await release(lock, await acquire(lock));
		await execute(resolveWindowsSystem32ExecutablePath("icacls.exe"), [lock, "/grant", "*S-1-5-32-544:(R)"], {
			timeout: 10_000,
			windowsHide: true,
		});
		await expectBusy(
			lock,
			"installation lock: DACL grants access to a principal other than the current user or LocalSystem",
		);
	});
	it("creates an owned shortcut with Windows app identity and preserves unrelated links", async () => {
		const target = join(root, "app target 项目.exe"),
			other = join(root, "other.exe"),
			shortcut = join(root, "Quarterdeck.lnk");
		await copyFile(executable, target);
		await copyFile(executable, other);
		const shortcutOperation = (operation: string, app = target) =>
			execute(executable, ["--quarterdeck-test-shortcut", operation, app, shortcut], {
				timeout: 10000,
				windowsHide: true,
			});
		await shortcutOperation("install");
		await shortcutOperation("install");
		await shortcutOperation("check");
		await expect(shortcutOperation("install", other)).rejects.toMatchObject({ code: 73 });
		await shortcutOperation("remove", other);
		await shortcutOperation("check");
		await shortcutOperation("remove");
		await expect(shortcutOperation("check")).rejects.toMatchObject({ code: 73 });
		await shortcutOperation("remove");
	});

	it.each(["QuarterdeckHost.exe", "host/Quarterdeck.exe"])(
		"repairs a Quarterdeck shortcut retargeted to %s",
		async (hostPath) => {
			const bootstrap = join(root, "Quarterdeck.exe");
			const host = join(root, hostPath);
			const shortcut = join(root, "Retargeted Quarterdeck.lnk");
			await copyFile(executable, bootstrap);
			await ensurePrivateDirectory(join(root, "host"));
			await copyFile(executable, host);
			const run = (operation: string, target: string) =>
				execute(executable, ["--quarterdeck-test-shortcut", operation, target, shortcut], {
					timeout: 10_000,
					windowsHide: true,
				});
			await run("install", host);
			await expect(run("check", bootstrap)).rejects.toMatchObject({ code: 73 });
			await run("install", bootstrap);
			await run("check", bootstrap);
			await run("remove", bootstrap);
		},
	);

	it("hands updates to Explorer outside the application's non-breakaway job", async (context) => {
		if (!(await listWindowsDesktopProcesses()).some((row) => /\\explorer\.exe(?:"|\s|$)/iu.test(row.command))) {
			context.skip();
			return;
		}
		const directory = join(root, "update-broker");
		await ensurePrivateDirectory(directory);
		const marker = join(directory, "ready"),
			done = join(directory, "done"),
			script = join(directory, "Update.ps1"),
			lock = join(directory, "admission.lock");
		const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
		await writeFile(
			script,
			`\uFEFF[IO.File]::WriteAllText(${quote(marker)},$PID.ToString()); Start-Sleep -Seconds 3; [IO.File]::WriteAllText(${quote(done)},'done')`,
		);
		const main = `const fs=require('node:fs');require('node:child_process').execFileSync(${JSON.stringify(executable)},['--quarterdeck-update-window',${JSON.stringify(script)}]);const deadline=Date.now()+10000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);console.log('HELPER_READY');process.exit(0)}if(Date.now()>deadline)process.exit(9)},30);`;
		const child = spawn(executable, ["--quarterdeck-test-exec", lock, process.execPath, "-e", main], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const exited = new Promise<number | null>((accept) => child.once("exit", accept));
		let failure: unknown;
		try {
			await ready(child);
			expect(await exited).toBe(0);
			await expect(readFile(done)).rejects.toMatchObject({ code: "ENOENT" });
			await release(lock, await acquire(lock));
		} catch (error) {
			failure = error;
		} finally {
			child.kill();
			await exited;
			const deadline = Date.now() + 10000;
			let completed = false;
			while (Date.now() < deadline) {
				try {
					await readFile(done);
					completed = true;
					break;
				} catch {
					await new Promise((accept) => setTimeout(accept, 100));
				}
			}
			if (!completed) failure ??= new Error("Synthetic Explorer worker cleanup was not confirmed.");
		}
		if (failure) throw failure;
	}, 25000);
});
