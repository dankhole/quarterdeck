import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let root: string;
let executable: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-native-admission-"));
	executable = join(root, "admission");
	const result = spawnSync(
		"/usr/bin/clang",
		[
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-DQUARTERDECK_ADMISSION_TEST",
			resolve("desktop/native/installation-admission.c"),
			"-o",
			executable,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr);
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});
function runWriter(lock: string, fd: number): Promise<number | null> {
	return new Promise((accept, reject) => {
		const child = spawn(executable, ["--quarterdeck-install-lock-fd", lock], {
			stdio: ["ignore", "ignore", "ignore", fd],
		});
		child.once("error", reject);
		child.once("exit", accept);
	});
}

describe.skipIf(process.platform !== "darwin")("native admission open-file lifetime", () => {
	it("keeps exclusive admission in the Node descriptor after the native lock child exits", async () => {
		const lock = join(root, "writer.lock");
		const first = await open(lock, "w+", 0o600);
		const second = await open(lock, "r+");
		try {
			expect(await runWriter(lock, first.fd)).toBe(0);
			expect(await runWriter(lock, second.fd)).not.toBe(0);
			await first.close();
			expect(await runWriter(lock, second.fd)).toBe(0);
		} finally {
			await first.close().catch(() => {});
			await second.close();
		}
	});
	it.each([false, true])(
		"holds admission after main exits (killed=%s) until the surviving Node helper closes",
		async (killMain) => {
			const lock = join(root, `shared-${killMain}.lock`);
			await writeFile(lock, "", { mode: 0o600 });
			const helper = `const fs=require('node:fs');fs.fstatSync(4);console.log('HELPER_READY');setTimeout(()=>process.exit(0),1000)`;
			const main = `const fs=require('node:fs');const cp=require('node:child_process');fs.fstatSync(198);const child=cp.spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit','ignore',198]});child.unref();${killMain ? "setTimeout(()=>{},10000)" : "setTimeout(()=>process.exit(0),100)"}`;
			const child = spawn(executable, ["--quarterdeck-test-exec", lock, process.execPath, "-e", main], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			const closed = new Promise<void>((accept) => child.once("close", () => accept()));
			const exited = new Promise<void>((accept) => child.once("exit", () => accept()));
			await new Promise<void>((accept, reject) => {
				child.stdout.on("data", (chunk: Buffer) => {
					if (chunk.toString().includes("HELPER_READY")) accept();
				});
				child.once("error", reject);
				child.once("exit", (code) => {
					if (code !== 0 && code !== null) reject(new Error(`main exited ${code}`));
				});
			});
			if (killMain) child.kill("SIGKILL");
			await exited;
			const contender = await open(lock, "r+");
			try {
				expect(await runWriter(lock, contender.fd)).not.toBe(0);
				await closed;
				expect(await runWriter(lock, contender.fd)).toBe(0);
			} finally {
				await contender.close();
				child.kill("SIGKILL");
			}
		},
	);
	it("refuses a named lock replaced by a symlink or a different inode", async () => {
		const lock = join(root, "identity.lock");
		const target = join(root, "other.lock");
		const descriptor = await open(lock, "w+", 0o600);
		await writeFile(target, "", { mode: 0o600 });
		try {
			await rm(lock);
			await symlink(target, lock);
			expect(await runWriter(lock, descriptor.fd)).not.toBe(0);
		} finally {
			await descriptor.close();
		}
	});
	it("refuses a lock below a user-owned symbolic link ancestor", async () => {
		const directory = join(root, "actual");
		const alias = join(root, "alias");
		await mkdir(directory, { mode: 0o700 });
		await symlink(directory, alias);
		const descriptor = await open(join(directory, "admission.lock"), "w+", 0o600);
		try {
			expect(await runWriter(join(alias, "admission.lock"), descriptor.fd)).not.toBe(0);
		} finally {
			await descriptor.close();
		}
	});
});
