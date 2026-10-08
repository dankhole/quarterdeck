import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOwnershipClaim } from "../../../src/core/api/runtime-management.js";
import type { OwnedProcessSnapshot } from "../../../src/server/owned-process-snapshot.js";
import { readRuntimeBootIdentity } from "../../../src/server/runtime-boot-identity.js";
import {
	acquireRuntimeOwnership,
	type RuntimeOwnershipLease,
	withRuntimeMaintenance,
} from "../../../src/server/runtime-ownership.js";
import {
	inspectRuntimeProcess,
	probeRuntimeProcess,
	readRuntimeHostIdentity,
	readRuntimeProcessIdentity,
} from "../../../src/server/runtime-process-identity.js";
import {
	acknowledgeRuntimeRecovery,
	inspectRuntimeRecovery,
} from "../../../src/server/runtime-recovery-acknowledgement.js";
import { assertRuntimeRecoveryAdmission } from "../../../src/server/runtime-recovery-admission.js";

vi.mock("../../../src/server/runtime-process-identity.js", () => ({
	readRuntimeProcessIdentity: vi.fn(),
	readRuntimeHostIdentity: vi.fn(),
	inspectRuntimeProcess: vi.fn(),
	probeRuntimeProcess: vi.fn(),
}));
vi.mock("../../../src/server/runtime-boot-identity.js", () => ({ readRuntimeBootIdentity: vi.fn() }));

const BOOT = "darwin:11111111-1111-1111-1111-111111111111";
const OTHER_BOOT = "darwin:22222222-2222-2222-2222-222222222222";
const absent = { snapshot: async (): Promise<OwnedProcessSnapshot[]> => [] };
const live = {
	snapshot: async () => [
		{ pid: 123, parentPid: 1, creationIdentity: "recycled", preciseIdentity: true, zombie: false },
	],
};

describe("explicit recovery acknowledgement", () => {
	let home: string;
	const leases: RuntimeOwnershipLease[] = [];
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "quarterdeck-recovery-ack-"));
		vi.mocked(readRuntimeProcessIdentity).mockResolvedValue({ pid: process.pid, creationIdentity: "test:current" });
		vi.mocked(readRuntimeHostIdentity).mockResolvedValue("test:stable-machine");
		vi.mocked(readRuntimeBootIdentity).mockResolvedValue(BOOT);
		vi.mocked(inspectRuntimeProcess).mockResolvedValue("dead");
		vi.mocked(probeRuntimeProcess).mockReturnValue("dead");
	});
	afterEach(async () => {
		for (const lease of leases.splice(0)) await lease.release().catch(() => undefined);
		await rm(home, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.resetAllMocks();
	});
	async function acquire(purpose: RuntimeOwnershipClaim["purpose"] = "runtime"): Promise<RuntimeOwnershipLease> {
		const result = await acquireRuntimeOwnership({ stateHome: home, quarterdeckVersion: "test", purpose });
		if (result.kind !== "acquired") throw new Error("Expected an exclusive synthetic lease.");
		leases.push(result.lease);
		return result.lease;
	}
	async function dirtyPrior(): Promise<RuntimeOwnershipLease> {
		const prior = await acquire();
		prior.markProcessCustodyDirty();
		return prior;
	}
	async function sessions(content = JSON.stringify({ task: { pid: 123, state: "running" } })): Promise<string> {
		const project = join(home, "projects", "project");
		await mkdir(project, { recursive: true });
		const path = join(project, "sessions.json");
		await writeFile(path, content);
		return path;
	}
	function receiptPath(lease: RuntimeOwnershipLease): string {
		return join(home, "runtime-ownership", "recovery-acknowledged", `${lease.generation}.json`);
	}
	async function admission(lease: RuntimeOwnershipLease, snapshot = absent.snapshot): Promise<void> {
		await assertRuntimeRecoveryAdmission({
			stateHome: home,
			currentGeneration: lease.generation,
			bootIdentity: BOOT,
			snapshot,
		});
	}

	it("inspects unconfirmed custody without publishing acknowledgement or changing saved evidence", async () => {
		const prior = await dirtyPrior();
		const saved = await sessions();
		const paths = [
			saved,
			join(home, "runtime-ownership", "first-owner.json"),
			join(home, "runtime-ownership", "custody-dirty", `${prior.generation}.json`),
		];
		const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
		const maintenance = await acquire("maintenance");
		expect(await inspectRuntimeRecovery(maintenance, absent)).toEqual({ recoveryRequired: true });
		expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("creates a private immutable receipt bound to the exact maintenance claim and leaves custody dirty", async () => {
		const prior = await dirtyPrior();
		const saved = await sessions();
		const content = await readFile(saved, "utf8");
		const maintenance = await acquire("maintenance");
		const signal = vi.spyOn(process, "kill");
		await acknowledgeRuntimeRecovery(maintenance, absent);
		expect(signal).not.toHaveBeenCalled();
		const path = receiptPath(maintenance);
		const receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(receipt).toMatchObject({
			version: 1,
			kind: "user_confirmed_prior_processes_stopped",
			boundaryClaim: maintenance.getClaim(),
			bootIdentity: BOOT,
		});
		expect((receipt.boundaryClaim as RuntimeOwnershipClaim).previousGeneration).toBe(prior.generation);
		expect(await readFile(saved, "utf8")).toBe(content);
		await expect(stat(join(home, "runtime-ownership", "released", `${prior.generation}.json`))).rejects.toMatchObject(
			{ code: "ENOENT" },
		);
		expect(
			await readFile(join(home, "runtime-ownership", "custody-dirty", `${prior.generation}.json`), "utf8"),
		).toContain(prior.generation);
		const bytes = await readFile(path, "utf8");
		await acknowledgeRuntimeRecovery(maintenance, absent);
		expect(await readFile(path, "utf8")).toBe(bytes);
		if (process.platform !== "win32") {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect((await stat(join(home, "runtime-ownership", "recovery-acknowledged"))).mode & 0o777).toBe(0o700);
		}
	});

	it("does not create a receipt for a fresh or genuinely clean home", async () => {
		let maintenance = await acquire("maintenance");
		expect((await inspectRuntimeRecovery(maintenance, absent)).recoveryRequired).toBe(false);
		await acknowledgeRuntimeRecovery(maintenance, absent);
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
		await maintenance.release();
		const runtime = await acquire();
		runtime.markProcessCustodyDirty();
		await runtime.release();
		await sessions();
		maintenance = await acquire("maintenance");
		expect((await inspectRuntimeRecovery(maintenance, live)).recoveryRequired).toBe(false);
		await acknowledgeRuntimeRecovery(maintenance, live);
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("admits acknowledged history on the same boot after rechecking saved PID absence", async () => {
		await dirtyPrior();
		await sessions();
		const maintenance = await acquire("maintenance");
		await acknowledgeRuntimeRecovery(maintenance, absent);
		await maintenance.release();
		const runtime = await acquire();
		await admission(runtime);
		await expect(admission(runtime, live.snapshot)).rejects.toMatchObject({
			reason: "live_prior_process",
			pids: [123],
		});
	});

	it("does not let an older clean release bypass the saved-process check after acknowledgement", async () => {
		const clean = await acquire();
		await clean.release();
		await dirtyPrior();
		await sessions();
		const maintenance = await acquire("maintenance");
		await acknowledgeRuntimeRecovery(maintenance, absent);
		await maintenance.release();
		await expect(admission(await acquire(), live.snapshot)).rejects.toMatchObject({ reason: "live_prior_process" });
	});

	it("keeps a newer dirty generation blocked by an older acknowledgement", async () => {
		await dirtyPrior();
		const maintenance = await acquire("maintenance");
		await acknowledgeRuntimeRecovery(maintenance, absent);
		await maintenance.release();
		const next = await acquire();
		await admission(next);
		next.markProcessCustodyDirty();
		await expect(admission(await acquire())).rejects.toMatchObject({ reason: "unconfirmed_prior_custody" });
	});

	it("refuses live PID-only evidence without sending signals or acknowledging", async () => {
		await dirtyPrior();
		await sessions();
		const maintenance = await acquire("maintenance");
		const signal = vi.spyOn(process, "kill");
		await expect(acknowledgeRuntimeRecovery(maintenance, live)).rejects.toMatchObject({
			reason: "live_prior_process",
		});
		expect(signal).not.toHaveBeenCalled();
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses a process appearing during the fresh pre-publication query", async () => {
		await dirtyPrior();
		await sessions();
		const maintenance = await acquire("maintenance");
		const snapshot = vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(live.snapshot);
		await expect(acknowledgeRuntimeRecovery(maintenance, { snapshot })).rejects.toMatchObject({
			reason: "live_prior_process",
		});
		expect(snapshot).toHaveBeenCalledTimes(2);
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(join(home, "runtime-ownership", "recovery-acknowledged"))).toEqual([]);
	});

	it("re-reads saved evidence before the final process absence query", async () => {
		await dirtyPrior();
		const saved = await sessions();
		const maintenance = await acquire("maintenance");
		const snapshot = vi
			.fn()
			.mockImplementationOnce(async () => {
				await writeFile(saved, JSON.stringify({ task: { pid: 456 } }));
				return [];
			})
			.mockResolvedValueOnce([
				{ pid: 456, parentPid: 1, creationIdentity: "live", preciseIdentity: false, zombie: false },
			]);
		await expect(acknowledgeRuntimeRecovery(maintenance, { snapshot })).rejects.toMatchObject({
			reason: "live_prior_process",
			pids: [456],
		});
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("requires the boot identity to remain verified through publication", async () => {
		await dirtyPrior();
		const maintenance = await acquire("maintenance");
		const readBootIdentity = vi
			.fn()
			.mockResolvedValueOnce(BOOT)
			.mockResolvedValueOnce(BOOT)
			.mockResolvedValueOnce(null);
		await expect(acknowledgeRuntimeRecovery(maintenance, { ...absent, readBootIdentity })).rejects.toMatchObject({
			reason: "boot_identity_unavailable",
		});
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("lets a later genuine runtime release supersede the acknowledgement process check", async () => {
		await dirtyPrior();
		await sessions();
		const maintenance = await acquire("maintenance");
		await acknowledgeRuntimeRecovery(maintenance, absent);
		await maintenance.release();
		const clean = await acquire();
		await admission(clean);
		clean.markProcessCustodyDirty();
		await clean.release();
		await admission(await acquire(), live.snapshot);
	});

	it("retains the exact Windows registry-only recycled-PID allowance during acknowledgement", async () => {
		await dirtyPrior();
		const registry = join(home, "managed-processes");
		await mkdir(registry);
		const recordId = "12345678-1234-1234-1234-123456789012";
		await writeFile(
			join(registry, `${recordId}.json`),
			JSON.stringify({
				version: 1,
				recordId,
				registeredAt: new Date().toISOString(),
				ownerRuntime: { pid: 999, creationTime: "50" },
				rootProcess: { pid: 123, creationTime: "100" },
			}),
		);
		const maintenance = await acquire("maintenance");
		await acknowledgeRuntimeRecovery(maintenance, {
			platform: "win32",
			snapshot: async () => [
				{ pid: 123, parentPid: 1, creationIdentity: "200", preciseIdentity: true, zombie: false },
			],
		});
		expect(await stat(receiptPath(maintenance))).toBeDefined();
	});

	it("refuses unavailable process queries", async () => {
		await dirtyPrior();
		await sessions();
		const maintenance = await acquire("maintenance");
		await expect(
			acknowledgeRuntimeRecovery(maintenance, {
				snapshot: async () => {
					throw new Error("unavailable");
				},
			}),
		).rejects.toMatchObject({ reason: "unverifiable_evidence" });
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([null, "darwin:garbage", OTHER_BOOT])(
		"refuses unavailable, malformed or changed boot identity %s",
		async (boot) => {
			await dirtyPrior();
			const maintenance = await acquire("maintenance");
			await expect(
				acknowledgeRuntimeRecovery(maintenance, { ...absent, readBootIdentity: async () => boot }),
			).rejects.toMatchObject({ reason: "boot_identity_unavailable" });
			await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("rechecks lease ownership after observation and before publishing", async () => {
		await dirtyPrior();
		await sessions();
		const maintenance = await acquire("maintenance");
		let queries = 0;
		const snapshot = async () => {
			if (++queries === 2) await maintenance.release();
			return [];
		};
		await expect(acknowledgeRuntimeRecovery(maintenance, { snapshot })).rejects.toMatchObject({
			code: "ownership_lost",
		});
		await expect(stat(receiptPath(maintenance))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["sessions.json", "state-transaction.json", "execution-ownership.json"])(
		"never dismisses corrupt retained %s after acknowledgement",
		async (name) => {
			await dirtyPrior();
			const saved = await sessions();
			const maintenance = await acquire("maintenance");
			await acknowledgeRuntimeRecovery(maintenance, absent);
			await maintenance.release();
			const path = join(home, "projects", "project", name);
			await writeFile(path, "corrupt saved evidence");
			await expect(admission(await acquire())).rejects.toMatchObject({ reason: "unverifiable_evidence" });
			expect(await readFile(path, "utf8")).toBe("corrupt saved evidence");
			if (name !== "sessions.json") expect(await readFile(saved, "utf8")).toContain("123");
		},
	);

	it("never dismisses corrupt managed records after acknowledgement", async () => {
		await dirtyPrior();
		const maintenance = await acquire("maintenance");
		await acknowledgeRuntimeRecovery(maintenance, absent);
		await maintenance.release();
		const registry = join(home, "managed-processes");
		await mkdir(registry);
		const path = join(registry, "12345678-1234-1234-1234-123456789012.json");
		await writeFile(path, "corrupt");
		await expect(admission(await acquire())).rejects.toMatchObject({ reason: "unverifiable_evidence" });
		expect(await readFile(path, "utf8")).toBe("corrupt");
	});

	it.each(["canonicalStateHome", "hostIdentity", "previousGeneration", "process", "bootIdentity"])(
		"rejects a receipt whose boundary %s was changed",
		async (field) => {
			await dirtyPrior();
			const maintenance = await acquire("maintenance");
			await acknowledgeRuntimeRecovery(maintenance, absent);
			const path = receiptPath(maintenance);
			const receipt = JSON.parse(await readFile(path, "utf8")) as { boundaryClaim: Record<string, unknown> };
			receipt.boundaryClaim[field] =
				field === "previousGeneration"
					? null
					: field === "process"
						? { pid: 321, creationIdentity: "replacement" }
						: "mismatched";
			await writeFile(path, JSON.stringify(receipt));
			await maintenance.release();
			await expect(admission(await acquire())).rejects.toMatchObject({ reason: "unverifiable_evidence" });
		},
	);

	it.each(["malformed", "oversized", "unreachable", "symlink"])(
		"rejects %s acknowledgement evidence",
		async (kind) => {
			await dirtyPrior();
			const maintenance = await acquire("maintenance");
			await acknowledgeRuntimeRecovery(maintenance, absent);
			const path = receiptPath(maintenance);
			if (kind === "malformed") await writeFile(path, "malformed");
			if (kind === "oversized") await writeFile(path, " ".repeat(16_385));
			if (kind === "unreachable")
				await writeFile(
					join(home, "runtime-ownership", "recovery-acknowledged", "12345678-1234-1234-1234-123456789012.json"),
					await readFile(path),
				);
			if (kind === "symlink") {
				const target = join(home, "receipt-copy.json");
				await writeFile(target, await readFile(path));
				await rm(path);
				await symlink(target, path);
			}
			await maintenance.release();
			await expect(admission(await acquire())).rejects.toMatchObject({ reason: "unverifiable_evidence" });
		},
	);

	it("requires maintenance and refuses acquisition while a runtime is live", async () => {
		const runtime = await dirtyPrior();
		await expect(acknowledgeRuntimeRecovery(runtime, absent)).rejects.toMatchObject({ code: "maintenance_busy" });
		vi.mocked(inspectRuntimeProcess).mockResolvedValue("live");
		await expect(
			withRuntimeMaintenance(home, async (lease) => acknowledgeRuntimeRecovery(lease, absent)),
		).rejects.toMatchObject({ code: "maintenance_busy" });
	});
});
