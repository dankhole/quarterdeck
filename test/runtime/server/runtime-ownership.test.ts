import { rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeOwnershipClaimSchema } from "../../../src/core/api/runtime-management.js";
import { readRuntimeBootIdentity } from "../../../src/server/runtime-boot-identity.js";
import {
	acquireRuntimeOwnership,
	discoverRuntimeOwner,
	type RuntimeOwnershipLease,
	readPriorRuntimeOwnershipClaims,
	resolveCanonicalRuntimeStateHome,
	withRuntimeMaintenance,
} from "../../../src/server/runtime-ownership.js";
import {
	inspectRuntimeProcess,
	probeRuntimeProcess,
	readRuntimeHostIdentity,
	readRuntimeProcessIdentity,
} from "../../../src/server/runtime-process-identity.js";

vi.mock("../../../src/server/runtime-process-identity.js", () => ({
	readRuntimeProcessIdentity: vi.fn(),
	readRuntimeHostIdentity: vi.fn(),
	inspectRuntimeProcess: vi.fn(),
	probeRuntimeProcess: vi.fn(),
}));
vi.mock("../../../src/server/runtime-boot-identity.js", () => ({ readRuntimeBootIdentity: vi.fn() }));

describe("runtime lifetime ownership", () => {
	let directory: string;
	const leases: RuntimeOwnershipLease[] = [];
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-runtime-owner-"));
		vi.mocked(readRuntimeProcessIdentity).mockResolvedValue({ pid: process.pid, creationIdentity: "test:current" });
		vi.mocked(readRuntimeHostIdentity).mockResolvedValue("test:stable-machine");
		vi.mocked(readRuntimeBootIdentity).mockResolvedValue("test:boot");
		vi.mocked(inspectRuntimeProcess).mockResolvedValue("live");
		vi.mocked(probeRuntimeProcess).mockReturnValue("live");
	});
	afterEach(async () => {
		for (const lease of leases.splice(0)) await lease.release().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
		vi.resetAllMocks();
	});
	async function acquire(home = directory, onOwnershipLost?: () => void): Promise<RuntimeOwnershipLease> {
		const result = await acquireRuntimeOwnership({ stateHome: home, quarterdeckVersion: "test", onOwnershipLost });
		expect(result.kind).toBe("acquired");
		if (result.kind !== "acquired") throw new Error("Expected owner.");
		leases.push(result.lease);
		return result.lease;
	}

	it("admits one competing writer without using port identity", async () => {
		const results = await Promise.all(
			Array.from({ length: 8 }, () => acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" })),
		);
		expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
		for (const result of results) if (result.kind === "acquired") leases.push(result.lease);
		expect(results.filter((result) => result.kind === "occupied")).toHaveLength(7);
	});

	it("fails closed on unavailable or foreign machine evidence before admitting another writer", async () => {
		vi.mocked(readRuntimeHostIdentity).mockRejectedValueOnce(new Error("Unavailable"));
		await expect(acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" })).rejects.toMatchObject(
			{ code: "identity_unavailable" },
		);
		await expect(stat(join(directory, "runtime-ownership"))).rejects.toMatchObject({ code: "ENOENT" });
		const first = await acquire();
		await first.release();
		vi.mocked(readRuntimeHostIdentity).mockResolvedValue("test:another-machine");
		await expect(acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" })).rejects.toMatchObject(
			{ code: "invalid_claim" },
		);
	});

	it("does not mistake a supervising desktop diagnostic journal for a legacy runtime", async () => {
		const instance = join(directory, "diagnostics", "instances", "desktop");
		await mkdir(instance, { recursive: true });
		await writeFile(join(instance, "runtime.json"), JSON.stringify({ pid: process.pid, processKind: "desktop" }));
		expect((await acquire()).isCurrent()).toBe(true);
	});

	it("permanently fences and preserves the same failed release outcome after a publication fault", async () => {
		const lease = await acquire();
		const releasedDirectory = join(directory, "runtime-ownership", "released");
		const firstRelease = lease.release();
		// Release fences synchronously, then yields while draining descriptor
		// persistence. Break only the synthetic destination before publication.
		rmSync(releasedDirectory, { recursive: true });
		writeFileSync(releasedDirectory, "synthetic publication fault");
		await expect(firstRelease).rejects.toMatchObject({ code: "ENOTDIR" });
		expect(lease.isCurrent()).toBe(false);
		expect(() => lease.assertCurrent()).toThrow("no longer owns");
		await rm(releasedDirectory);
		await mkdir(releasedDirectory);
		const secondRelease = lease.release();
		expect(secondRelease).toBe(firstRelease);
		await expect(secondRelease).rejects.toMatchObject({ code: "ENOTDIR" });
		await expect(stat(join(releasedDirectory, `${lease.generation}.json`))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("walks a multi-generation history before admission", async () => {
		const initial = await acquire();
		await initial.release();
		const root = join(directory, "runtime-ownership");
		const initialClaim = runtimeOwnershipClaimSchema.parse(
			JSON.parse(await readFile(join(root, "first-owner.json"), "utf8")),
		);
		let predecessor = initial.generation;
		const writes: Promise<void>[] = [];
		for (let index = 1; index < 32; index++) {
			const generation = randomUUID();
			writes.push(
				writeFile(
					join(root, "successors", `${predecessor}.json`),
					JSON.stringify({ ...initialClaim, generation, previousGeneration: predecessor }),
				),
			);
			predecessor = generation;
		}
		await Promise.all(writes);
		vi.mocked(inspectRuntimeProcess).mockResolvedValue("dead");
		const current = await acquire();
		expect(current.generation).not.toBe(predecessor);
		expect(current.isCurrent()).toBe(true);
		expect(JSON.parse(await readFile(join(root, "successors", `${predecessor}.json`), "utf8"))).toMatchObject({
			generation: current.generation,
			previousGeneration: predecessor,
		});
	});

	it("publishes process custody synchronously and reports prior exact release and dirty evidence", async () => {
		const clean = await acquire();
		await clean.release();
		const dirty = await acquire();
		dirty.markProcessCustodyDirty();
		expect(
			await readFile(join(directory, "runtime-ownership", "custody-dirty", `${dirty.generation}.json`), "utf8"),
		).toContain(dirty.generation);
		dirty.markProcessCustodyDirty();
		vi.mocked(inspectRuntimeProcess).mockResolvedValue("dead");
		const current = await acquire();
		const history = await readPriorRuntimeOwnershipClaims(directory, current.generation);
		expect(
			history.map(({ claim, released, custodyDirty }) => ({
				generation: claim.generation,
				released,
				custodyDirty,
				boot: claim.bootIdentity,
			})),
		).toEqual([
			{ generation: clean.generation, released: true, custodyDirty: false, boot: "test:boot" },
			{ generation: dirty.generation, released: false, custodyDirty: true, boot: "test:boot" },
		]);
		expect(() => dirty.markProcessCustodyDirty()).toThrow("no longer owns");
		await expect(readPriorRuntimeOwnershipClaims(directory, dirty.generation)).rejects.toMatchObject({
			code: "ownership_lost",
		});
		await writeFile(join(directory, "runtime-ownership", "custody-dirty", `${dirty.generation}.json`), "corrupt");
		await expect(readPriorRuntimeOwnershipClaims(directory, current.generation)).rejects.toMatchObject({
			code: "invalid_claim",
		});
	});

	it("keeps a live or ambiguous owner despite arbitrarily stale filesystem timestamps", async () => {
		const lease = await acquire();
		await utimes(join(directory, "runtime-ownership", "first-owner.json"), 1, 1);
		for (const state of ["live", "unknown"] as const) {
			vi.mocked(inspectRuntimeProcess).mockResolvedValue(state);
			const result = await acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "other" });
			expect(result.kind).toBe("occupied");
		}
		expect(lease.isCurrent()).toBe(true);
	});

	it("allows independent homes and canonicalizes existing symlink aliases", async () => {
		const home = join(directory, "actual", "state");
		await mkdir(join(directory, "actual"));
		await symlink(
			join(directory, "actual"),
			join(directory, "alias"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const first = await acquire(home);
		expect(await resolveCanonicalRuntimeStateHome(join(directory, "alias", "state"))).toBe(first.canonicalStateHome);
		expect(
			(await acquireRuntimeOwnership({ stateHome: join(directory, "alias", "state"), quarterdeckVersion: "test" }))
				.kind,
		).toBe("occupied");
		expect((await acquire(join(directory, "other"))).isCurrent()).toBe(true);
	});

	it("fences before release and never deletes an immutable claim", async () => {
		const first = await acquire();
		const bytes = await readFile(join(directory, "runtime-ownership", "first-owner.json"), "utf8");
		const release = first.release();
		expect(first.isCurrent()).toBe(false);
		await release;
		const second = await acquire();
		expect(second.generation).not.toBe(first.generation);
		expect(await readFile(join(directory, "runtime-ownership", "first-owner.json"), "utf8")).toBe(bytes);
		expect((await discoverRuntimeOwner(directory))?.claim.generation).toBe(second.generation);
	});

	it("allows exactly one successor after proven death and fences the superseded handle", async () => {
		const lost = vi.fn();
		const first = await acquire(directory, lost);
		vi.mocked(inspectRuntimeProcess).mockImplementation(async (identity) =>
			identity.creationIdentity === "test:current" ? "dead" : "live",
		);
		vi.mocked(readRuntimeProcessIdentity).mockResolvedValue({
			pid: process.pid,
			creationIdentity: "test:replacement",
		});
		const results = await Promise.all(
			Array.from({ length: 8 }, () => acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" })),
		);
		expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
		for (const result of results) if (result.kind === "acquired") leases.push(result.lease);
		expect(first.isCurrent()).toBe(false);
		expect(() => first.assertCurrent()).toThrow("no longer owns");
		expect(lost).toHaveBeenCalledTimes(1);
	});

	it("publishes private readiness and authenticates only current management credentials", async () => {
		const lease = await acquire();
		expect(lease.getDescriptor()?.status).toBe("starting");
		await lease.markReady({ host: "127.0.0.1", port: 3999 });
		const descriptor = lease.getDescriptor();
		expect(descriptor?.endpoint).toEqual({ host: "127.0.0.1", port: 3999 });
		expect(descriptor?.capabilities.transportVersion).toBe(1);
		expect(lease.getPublicDescriptor()).not.toHaveProperty("managementToken");
		expect(lease.verifyManagementToken(descriptor?.managementToken, lease.generation)).toBe(true);
		expect(lease.verifyManagementToken(descriptor?.managementToken, "wrong-generation")).toBe(false);
		expect(lease.verifyManagementToken("diagnostic-credential", lease.generation)).toBe(false);
		if (process.platform !== "win32") {
			expect((await stat(join(directory, "runtime-ownership"))).mode & 0o777).toBe(0o700);
			expect(
				(await stat(join(directory, "runtime-ownership", "descriptors", `${lease.generation}.json`))).mode & 0o777,
			).toBe(0o600);
		}
		await lease.markStopping();
		expect((await discoverRuntimeOwner(directory))?.descriptor?.status).toBe("stopping");
		await lease.release();
		expect(lease.verifyManagementToken(descriptor?.managementToken, lease.generation)).toBe(false);
	});

	it("blocks corruption rather than reclaiming an unreadable claim", async () => {
		await acquire();
		await writeFile(join(directory, "runtime-ownership", "first-owner.json"), "broken", "utf8");
		await expect(acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" })).rejects.toMatchObject(
			{ code: "invalid_claim" },
		);
	});

	it("blocks malformed successor and mismatched release evidence", async () => {
		const lease = await acquire();
		const root = join(directory, "runtime-ownership");
		await writeFile(join(root, "released", `${lease.generation}.json`), "{}", "utf8");
		await expect(discoverRuntimeOwner(directory)).rejects.toMatchObject({ code: "invalid_claim" });
		await rm(join(root, "released", `${lease.generation}.json`));
		await writeFile(join(root, "successors", `${lease.generation}.json`), "{}", "utf8");
		await expect(acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" })).rejects.toMatchObject(
			{ code: "invalid_claim" },
		);
	});

	it("refuses known legacy live runtimes and admits a proven dead legacy PID", async () => {
		const instance = join(directory, "diagnostics", "instances", "legacy");
		await mkdir(instance, { recursive: true });
		await writeFile(join(instance, "runtime.json"), JSON.stringify({ pid: 321, status: "stopped" }));
		await expect(acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" })).rejects.toMatchObject(
			{ code: "legacy_live_owner" },
		);
		vi.mocked(probeRuntimeProcess).mockReturnValue("dead");
		await acquire();
	});

	it("uses the same lease for offline maintenance and releases on failure", async () => {
		await expect(
			withRuntimeMaintenance(directory, async (lease) => {
				expect(lease.getDescriptor()).toBeNull();
				const other = await acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" });
				expect(other.kind).toBe("occupied");
				throw new Error("operation failed");
			}),
		).rejects.toThrow("operation failed");
		const runtime = await acquire();
		await expect(withRuntimeMaintenance(directory, async () => undefined)).rejects.toMatchObject({
			code: "maintenance_busy",
		});
		expect(runtime.isCurrent()).toBe(true);
	});

	it("ignores diagnostics only for exact released live owners across reachable generations", async () => {
		const first = await acquire();
		const instance = join(directory, "diagnostics", "instances", "released-owner");
		await mkdir(instance, { recursive: true });
		await writeFile(join(instance, "runtime.json"), JSON.stringify({ pid: process.pid, status: "stopped" }));
		await first.release();
		vi.mocked(readRuntimeProcessIdentity).mockResolvedValue({ pid: 456, creationIdentity: "test:second" });
		const second = await acquire();
		await second.release();
		vi.mocked(readRuntimeProcessIdentity).mockResolvedValue({ pid: 789, creationIdentity: "test:third" });
		const third = await acquire();
		expect(third.isCurrent()).toBe(true);
	});

	it("does not infer a legacy owner is released when its birth identity is unverified", async () => {
		const first = await acquire();
		const instance = join(directory, "diagnostics", "instances", "ambiguous-owner");
		await mkdir(instance, { recursive: true });
		await writeFile(join(instance, "runtime.json"), JSON.stringify({ pid: process.pid, status: "stopped" }));
		await first.release();
		vi.mocked(inspectRuntimeProcess).mockResolvedValue("unknown");
		await expect(acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" })).rejects.toMatchObject(
			{ code: "legacy_live_owner" },
		);
	});
});

import { randomUUID } from "node:crypto";
