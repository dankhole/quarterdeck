import { afterEach, describe, expect, it, vi } from "vitest";

import {
	clearProjectBoardCache,
	invalidateProjectBoardCache,
	type ProjectBoardCacheEntry,
	restoreProjectBoard,
	stashProjectBoard,
	updateProjectBoardCache,
} from "@/runtime/project-board-cache";
import type { BoardData } from "@/types";

function createEntry(
	overrides?: Partial<Omit<ProjectBoardCacheEntry, "cachedAt">>,
): Omit<ProjectBoardCacheEntry, "cachedAt"> {
	return {
		board: { columns: [], dependencies: [] } as BoardData,
		sessions: {},
		revision: 1,
		workspacePath: "/test",
		workspaceGit: null,
		...overrides,
	};
}

afterEach(() => {
	clearProjectBoardCache();
	vi.restoreAllMocks();
});

describe("project-board-cache", () => {
	it("stashes and restores a board", () => {
		const entry = createEntry({ revision: 5 });
		stashProjectBoard("proj-1", entry);

		const restored = restoreProjectBoard("proj-1");
		expect(restored).not.toBeNull();
		expect(restored!.revision).toBe(5);
		expect(restored!.workspacePath).toBe("/test");
	});

	it("returns null for unknown project", () => {
		expect(restoreProjectBoard("unknown")).toBeNull();
	});

	it("skips stash when revision is null", () => {
		stashProjectBoard("proj-1", createEntry({ revision: null as unknown as number }));
		expect(restoreProjectBoard("proj-1")).toBeNull();
	});

	it("returns null for expired entries", () => {
		vi.useFakeTimers();
		stashProjectBoard("proj-1", createEntry());
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		expect(restoreProjectBoard("proj-1")).toBeNull();
		vi.useRealTimers();
	});

	it("returns entry within TTL", () => {
		vi.useFakeTimers();
		stashProjectBoard("proj-1", createEntry());
		vi.advanceTimersByTime(4 * 60 * 1000);
		expect(restoreProjectBoard("proj-1")).not.toBeNull();
		vi.useRealTimers();
	});

	it("evicts oldest when exceeding max entries", () => {
		vi.useFakeTimers();
		for (let i = 0; i < 10; i++) {
			stashProjectBoard(`proj-${i}`, createEntry({ revision: i }));
			vi.advanceTimersByTime(10);
		}
		stashProjectBoard("proj-overflow", createEntry({ revision: 99 }));

		expect(restoreProjectBoard("proj-0")).toBeNull();
		expect(restoreProjectBoard("proj-1")).not.toBeNull();
		expect(restoreProjectBoard("proj-overflow")).not.toBeNull();
		vi.useRealTimers();
	});

	it("updateProjectBoardCache only updates existing entries", () => {
		updateProjectBoardCache("proj-1", createEntry({ revision: 10 }));
		expect(restoreProjectBoard("proj-1")).toBeNull();

		stashProjectBoard("proj-1", createEntry({ revision: 1 }));
		updateProjectBoardCache("proj-1", createEntry({ revision: 10 }));
		expect(restoreProjectBoard("proj-1")!.revision).toBe(10);
	});

	it("invalidateProjectBoardCache removes a specific entry", () => {
		stashProjectBoard("proj-1", createEntry());
		stashProjectBoard("proj-2", createEntry());

		invalidateProjectBoardCache("proj-1");
		expect(restoreProjectBoard("proj-1")).toBeNull();
		expect(restoreProjectBoard("proj-2")).not.toBeNull();
	});

	it("clearProjectBoardCache removes all entries", () => {
		stashProjectBoard("proj-1", createEntry());
		stashProjectBoard("proj-2", createEntry());

		clearProjectBoardCache();
		expect(restoreProjectBoard("proj-1")).toBeNull();
		expect(restoreProjectBoard("proj-2")).toBeNull();
	});

	it("overwrites existing entry on re-stash", () => {
		stashProjectBoard("proj-1", createEntry({ revision: 1 }));
		stashProjectBoard("proj-1", createEntry({ revision: 2 }));
		expect(restoreProjectBoard("proj-1")!.revision).toBe(2);
	});
});
