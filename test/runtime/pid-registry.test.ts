import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock getRuntimeHomePath to use a temp directory so tests don't touch real state.
let tempDir: string;

vi.mock("../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => tempDir,
}));

// Mock debug logger to avoid side effects.
vi.mock("../../src/core/debug-logger", () => ({
	createTaggedLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import {
	clearPidRegistry,
	type ManagedPidEntry,
	periodicPidSweep,
	registerManagedPid,
	sweepOrphanedPids,
	unregisterManagedPid,
} from "../../src/terminal/pid-registry";

const REGISTRY_FILENAME = "managed-pids.json";

async function readRegistry(): Promise<Record<string, ManagedPidEntry>> {
	try {
		const raw = await readFile(join(tempDir, REGISTRY_FILENAME), "utf-8");
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

async function writeRegistry(data: Record<string, ManagedPidEntry>): Promise<void> {
	await writeFile(join(tempDir, REGISTRY_FILENAME), JSON.stringify(data), "utf-8");
}

describe("pid-registry", () => {
	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "qd-pid-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("registerManagedPid", () => {
		it("creates a registry file with the PID entry", async () => {
			await registerManagedPid(12345, {
				taskId: "task-1",
				agentId: "claude-code",
				spawnedAt: 1000,
			});

			const registry = await readRegistry();
			expect(registry["12345"]).toEqual({
				taskId: "task-1",
				agentId: "claude-code",
				spawnedAt: 1000,
			});
		});

		it("adds to an existing registry without overwriting other entries", async () => {
			await registerManagedPid(100, { taskId: "a", agentId: "claude-code", spawnedAt: 1000 });
			await registerManagedPid(200, { taskId: "b", agentId: "codex", spawnedAt: 2000 });

			const registry = await readRegistry();
			expect(Object.keys(registry)).toHaveLength(2);
			expect(registry["100"]?.taskId).toBe("a");
			expect(registry["200"]?.taskId).toBe("b");
		});

		it("concurrent registrations are serialized and no entries are lost", async () => {
			// Fire multiple registrations concurrently — without serialization,
			// the last write would overwrite earlier ones.
			await Promise.all([
				registerManagedPid(100, { taskId: "a", agentId: "claude-code", spawnedAt: 1000 }),
				registerManagedPid(200, { taskId: "b", agentId: "claude-code", spawnedAt: 2000 }),
				registerManagedPid(300, { taskId: "c", agentId: "claude-code", spawnedAt: 3000 }),
			]);

			const registry = await readRegistry();
			expect(Object.keys(registry)).toHaveLength(3);
			expect(registry["100"]?.taskId).toBe("a");
			expect(registry["200"]?.taskId).toBe("b");
			expect(registry["300"]?.taskId).toBe("c");
		});
	});

	describe("unregisterManagedPid", () => {
		it("removes a PID entry from the registry", async () => {
			await registerManagedPid(100, { taskId: "a", agentId: "claude-code", spawnedAt: 1000 });
			await registerManagedPid(200, { taskId: "b", agentId: "codex", spawnedAt: 2000 });

			await unregisterManagedPid(100);

			const registry = await readRegistry();
			expect(registry["100"]).toBeUndefined();
			expect(registry["200"]).toBeDefined();
		});

		it("is a no-op if the PID is not in the registry", async () => {
			await registerManagedPid(100, { taskId: "a", agentId: "claude-code", spawnedAt: 1000 });

			await unregisterManagedPid(999);

			const registry = await readRegistry();
			expect(registry["100"]).toBeDefined();
		});

		it("handles missing registry file gracefully", async () => {
			// No registry file exists — should not throw.
			await expect(unregisterManagedPid(100)).resolves.toBeUndefined();
		});
	});

	describe("clearPidRegistry", () => {
		it("empties the registry", async () => {
			await registerManagedPid(100, { taskId: "a", agentId: "claude-code", spawnedAt: 1000 });
			await registerManagedPid(200, { taskId: "b", agentId: "codex", spawnedAt: 2000 });

			await clearPidRegistry();

			const registry = await readRegistry();
			expect(Object.keys(registry)).toHaveLength(0);
		});
	});

	describe("sweepOrphanedPids", () => {
		it("returns zeroes when the registry is empty", async () => {
			const result = await sweepOrphanedPids();
			expect(result).toEqual({ checked: 0, killed: 0, stale: 0, skipped: 0 });
		});

		it("marks dead processes as stale and clears the registry", async () => {
			// Use a PID that almost certainly doesn't exist.
			await writeRegistry({
				"99999999": { taskId: "dead-task", agentId: "claude-code", spawnedAt: Date.now() - 60_000 },
			});

			const result = await sweepOrphanedPids();
			expect(result.checked).toBe(1);
			expect(result.stale).toBe(1);
			expect(result.killed).toBe(0);

			// Registry should be cleared after sweep.
			const registry = await readRegistry();
			expect(Object.keys(registry)).toHaveLength(0);
		});

		it("handles corrupted registry file gracefully", async () => {
			await writeFile(join(tempDir, REGISTRY_FILENAME), "not valid json", "utf-8");

			const result = await sweepOrphanedPids();
			expect(result).toEqual({ checked: 0, killed: 0, stale: 0, skipped: 0 });
		});
	});

	describe("periodicPidSweep", () => {
		it("skips PIDs that are in the activePids set", async () => {
			// Register a PID that is "active" (managed by the session manager).
			const pid = process.pid; // Current process — definitely alive.
			await writeRegistry({
				[String(pid)]: { taskId: "active-task", agentId: "claude-code", spawnedAt: Date.now() },
			});

			const activePids = new Set([pid]);
			const result = await periodicPidSweep(activePids);

			// Should skip the active PID entirely — not even counted as checked.
			expect(result.checked).toBe(0);
			expect(result.killed).toBe(0);

			// Entry should still be in the registry (not removed).
			const registry = await readRegistry();
			expect(registry[String(pid)]).toBeDefined();
		});

		it("cleans up dead PIDs not in the active set", async () => {
			await writeRegistry({
				"99999999": { taskId: "gone-task", agentId: "claude-code", spawnedAt: Date.now() - 60_000 },
			});

			const result = await periodicPidSweep(new Set());
			expect(result.checked).toBe(1);
			expect(result.stale).toBe(1);

			const registry = await readRegistry();
			expect(registry["99999999"]).toBeUndefined();
		});
	});
});
