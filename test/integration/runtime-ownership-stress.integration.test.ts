import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeOwnershipClaimSchema } from "../../src/core/api/runtime-management.js";
import { readRuntimeBootIdentity } from "../../src/server/runtime-boot-identity.js";
import { acquireRuntimeOwnership, type RuntimeOwnershipLease } from "../../src/server/runtime-ownership.js";
import {
	inspectRuntimeProcess,
	probeRuntimeProcess,
	readRuntimeHostIdentity,
	readRuntimeProcessIdentity,
} from "../../src/server/runtime-process-identity.js";

vi.mock("../../src/server/runtime-process-identity.js", () => ({
	readRuntimeProcessIdentity: vi.fn(),
	readRuntimeHostIdentity: vi.fn(),
	inspectRuntimeProcess: vi.fn(),
	probeRuntimeProcess: vi.fn(),
}));
vi.mock("../../src/server/runtime-boot-identity.js", () => ({ readRuntimeBootIdentity: vi.fn() }));

// Keep the large real-filesystem regression in the cross-boundary lane. The
// fast ownership suite retains a smaller chain; this catches recursive walks.
describe("deep runtime ownership history", () => {
	let directory: string;
	const leases: RuntimeOwnershipLease[] = [];
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-runtime-owner-stress-"));
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
	async function acquire(): Promise<RuntimeOwnershipLease> {
		const result = await acquireRuntimeOwnership({ stateHome: directory, quarterdeckVersion: "test" });
		expect(result.kind).toBe("acquired");
		if (result.kind !== "acquired") throw new Error("Expected owner.");
		leases.push(result.lease);
		return result.lease;
	}

	it("walks a ten-thousand-generation history iteratively before admission", async () => {
		const initial = await acquire();
		await initial.release();
		const root = join(directory, "runtime-ownership");
		const initialClaim = runtimeOwnershipClaimSchema.parse(
			JSON.parse(await readFile(join(root, "first-owner.json"), "utf8")),
		);
		let predecessor = initial.generation;
		for (let offset = 1; offset < 10_000; offset += 100) {
			const writes: Promise<void>[] = [];
			for (let index = offset; index < Math.min(offset + 100, 10_000); index++) {
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
		}
		vi.mocked(inspectRuntimeProcess).mockResolvedValue("dead");
		const startedAt = performance.now();
		const current = await acquire();
		const elapsedMs = performance.now() - startedAt;
		expect(current.generation).not.toBe(predecessor);
		expect(current.isCurrent()).toBe(true);
		console.info(`Synthetic 10000-generation ownership admission: ${Math.round(elapsedMs)}ms`);
	}, 30_000);
});
