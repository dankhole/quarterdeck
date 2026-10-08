import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRuntimeMaintenance } from "../../src/server/runtime-ownership.js";

interface RecoveryChildResult {
	kind: "ready" | "inspected" | "admitted" | "denied";
	generation?: string;
	bootIdentity?: string | null;
	recoveryRequired?: boolean;
	reason?: string;
}

describe("cross-process explicit runtime recovery", () => {
	let home: string;
	const children: ChildProcess[] = [];
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "quarterdeck-process-recovery-"));
	});
	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			child.kill("SIGKILL");
			await exited;
		}
		await rm(home, { recursive: true, force: true });
	});
	function launch(mode: "dirty-owner" | "admit" | "inspect" | "acknowledge") {
		const child = fork(resolve("test/utilities/runtime-recovery-child.ts"), [mode], {
			execArgv: ["--import", "tsx"],
			env: { ...process.env, QUARTERDECK_TEST_RECOVERY_HOME: home },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		child.stdout?.resume();
		let stderr = "";
		child.stderr?.setEncoding("utf8").on("data", (data: string) => {
			stderr += data;
		});
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		const result = new Promise<RecoveryChildResult>((done, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`Recovery fixture exited before result (${code}): ${stderr}`)));
			child.once("message", (message: unknown) => {
				if (
					typeof message !== "object" ||
					message === null ||
					!("kind" in message) ||
					!["ready", "inspected", "admitted", "denied"].includes(String(message.kind))
				)
					reject(new Error("Unexpected recovery fixture result."));
				else done(message as RecoveryChildResult);
			});
		});
		return { child, result, exited };
	}
	async function complete(mode: "admit" | "inspect" | "acknowledge"): Promise<RecoveryChildResult> {
		const run = launch(mode);
		const result = await run.result;
		await run.exited;
		return result;
	}

	it("permits the next runtime on the same boot only after explicit acknowledgement, preserving original evidence", async () => {
		const prior = launch("dirty-owner");
		const dirty = await prior.result;
		expect(dirty.kind).toBe("ready");
		expect(dirty.bootIdentity).toMatch(/^(darwin|linux|windows):/u);
		const evidence = [
			join(home, "runtime-ownership", "first-owner.json"),
			join(home, "runtime-ownership", "custody-dirty", `${dirty.generation}.json`),
			join(home, "projects", "synthetic", "sessions.json"),
		];
		const before = await Promise.all(evidence.map((path) => readFile(path, "utf8")));
		prior.child.kill("SIGKILL");
		await prior.exited;
		expect(await complete("admit")).toMatchObject({ kind: "denied", reason: "unconfirmed_prior_custody" });
		expect(await complete("inspect")).toMatchObject({
			kind: "inspected",
			recoveryRequired: true,
			bootIdentity: dirty.bootIdentity,
		});
		await expect(stat(join(home, "runtime-ownership", "recovery-acknowledged"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const confirmed = await complete("acknowledge");
		expect(confirmed).toMatchObject({ kind: "inspected", recoveryRequired: true, bootIdentity: dirty.bootIdentity });
		expect(await readdir(join(home, "runtime-ownership", "recovery-acknowledged"))).toEqual([
			`${confirmed.generation}.json`,
		]);
		expect(await complete("admit")).toMatchObject({ kind: "admitted", bootIdentity: dirty.bootIdentity });
		expect(await Promise.all(evidence.map((path) => readFile(path, "utf8")))).toEqual(before);
		await expect(stat(join(home, "runtime-ownership", "released", `${dirty.generation}.json`))).rejects.toMatchObject(
			{ code: "ENOENT" },
		);
	}, 30_000);

	it("denies maintenance while a real prior owner remains alive", async () => {
		const prior = launch("dirty-owner");
		expect((await prior.result).kind).toBe("ready");
		await expect(withRuntimeMaintenance(home, async () => undefined)).rejects.toMatchObject({
			code: "maintenance_busy",
		});
		await expect(stat(join(home, "runtime-ownership", "recovery-acknowledged"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("refuses live saved PID-only evidence without terminating that unrelated process", async () => {
		const prior = launch("dirty-owner");
		await prior.result;
		prior.child.kill("SIGKILL");
		await prior.exited;
		const path = join(home, "projects", "synthetic", "sessions.json");
		const content = JSON.stringify({ synthetic: { pid: process.pid } });
		await writeFile(path, content);
		expect(await complete("acknowledge")).toMatchObject({ kind: "denied", reason: "live_prior_process" });
		expect(await readFile(path, "utf8")).toBe(content);
		await expect(stat(join(home, "runtime-ownership", "recovery-acknowledged"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
