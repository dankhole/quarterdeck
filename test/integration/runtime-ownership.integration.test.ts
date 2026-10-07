import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireRuntimeOwnership,
	discoverRuntimeOwner,
	type RuntimeOwnershipLease,
} from "../../src/server/runtime-ownership.js";
import { inspectRuntimeProcess, readRuntimeProcessIdentity } from "../../src/server/runtime-process-identity.js";

interface ChildAdmission {
	kind: "acquired" | "occupied";
	generation: string;
}

describe("cross-process runtime ownership", () => {
	let directory: string;
	const children: ChildProcess[] = [];
	const leases: RuntimeOwnershipLease[] = [];
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-owner-process-"));
	});
	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			child.kill("SIGKILL");
			await exited;
		}
		for (const lease of leases.splice(0)) await lease.release().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	});
	function launch(home = directory): { child: ChildProcess; admitted: Promise<ChildAdmission> } {
		const child = fork(resolve("test/utilities/runtime-ownership-child.ts"), [], {
			execArgv: ["--import", "tsx"],
			env: { ...process.env, QUARTERDECK_TEST_OWNERSHIP_HOME: home },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		child.stdout?.resume();
		let stderr = "";
		child.stderr?.setEncoding("utf8").on("data", (data: string) => {
			stderr += data;
		});
		const admitted = new Promise<ChildAdmission>((done, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => {
				reject(new Error(`Ownership fixture exited before admission (${code}): ${stderr}`));
			});
			child.once("message", (message: unknown) => {
				if (
					typeof message === "object" &&
					message !== null &&
					"kind" in message &&
					"generation" in message &&
					(message.kind === "acquired" || message.kind === "occupied") &&
					typeof message.generation === "string"
				) {
					done({ kind: message.kind, generation: message.generation });
				} else reject(new Error("Unexpected fixture admission."));
			});
		});
		return { child, admitted };
	}

	it("admits one simultaneous process for a home and independent processes for different homes", async () => {
		const contenders = [launch(), launch()];
		const results = await Promise.all(contenders.map((contender) => contender.admitted));
		expect(results.map((result) => result.kind).sort()).toEqual(["acquired", "occupied"]);
		expect(new Set(results.map((result) => result.generation)).size).toBe(1);
		expect((await launch(join(directory, "independent")).admitted).kind).toBe("acquired");
	});

	it.skipIf(process.platform === "win32")("never steals a SIGSTOP-paused owner with stale timestamps", async () => {
		const owner = launch();
		expect((await owner.admitted).kind).toBe("acquired");
		expect(owner.child.kill("SIGSTOP")).toBe(true);
		await utimes(join(directory, "runtime-ownership", "first-owner.json"), 1, 1);
		const contender = await acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" });
		expect(contender.kind).toBe("occupied");
		expect((await discoverRuntimeOwner(directory))?.processState).toBe("live");
		owner.child.kill("SIGCONT");
	});

	it("reclaims proven dead process identity with exactly one successor", async () => {
		const owner = launch();
		const admission = await owner.admitted;
		const identity = await readRuntimeProcessIdentity(Number(owner.child.pid));
		expect(identity).not.toBeNull();
		const exited = new Promise<void>((done) => owner.child.once("exit", () => done()));
		owner.child.kill("SIGKILL");
		await exited;
		if (!identity) throw new Error("Expected process birth identity.");
		expect(await inspectRuntimeProcess(identity)).toBe("dead");
		const replacements = [launch(), launch(), launch()];
		const results = await Promise.all(replacements.map((replacement) => replacement.admitted));
		expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
		expect(new Set(results.map((result) => result.generation)).size).toBe(1);
		expect(results[0]?.generation).not.toBe(admission.generation);
	});

	it("accepts voluntary release while the old process remains alive", async () => {
		const owner = launch();
		expect((await owner.admitted).kind).toBe("acquired");
		const released = new Promise<void>((done) => owner.child.once("message", () => done()));
		owner.child.send("release");
		await released;
		const result = await acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" });
		expect(result.kind).toBe("acquired");
		if (result.kind === "acquired") leases.push(result.lease);
		expect(owner.child.exitCode).toBeNull();
	});

	it.skipIf(process.platform !== "darwin")("uses stable process birth evidence across caller timezones", async () => {
		const priorTimezone = process.env.TZ;
		try {
			process.env.TZ = "Pacific/Honolulu";
			const first = await readRuntimeProcessIdentity(process.pid);
			process.env.TZ = "Asia/Tokyo";
			expect(await readRuntimeProcessIdentity(process.pid)).toEqual(first);
		} finally {
			if (priorTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = priorTimezone;
		}
	});
});
