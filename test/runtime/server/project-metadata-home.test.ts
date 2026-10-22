import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	probeGitWorkdirState: vi.fn(),
	getGitSyncSummary: vi.fn(),
	stashCount: vi.fn(),
	invalidateGitRepositoryInfoCache: vi.fn(),
	loadConflictState: vi.fn(),
}));

vi.mock("../../../src/workdir", () => ({
	probeGitWorkdirState: mocks.probeGitWorkdirState,
	getGitSyncSummary: mocks.getGitSyncSummary,
	stashCount: mocks.stashCount,
}));
vi.mock("../../../src/state/project-state-utils", () => ({
	invalidateGitRepositoryInfoCache: mocks.invalidateGitRepositoryInfoCache,
}));
vi.mock("../../../src/server/project-metadata-path-loader", () => ({
	loadConflictState: mocks.loadConflictState,
}));

import type { CachedHomeGitMetadata } from "../../../src/server/project-metadata-home";
import { loadHomeGitMetadata } from "../../../src/server/project-metadata-home";

function currentHomeGit(overrides: Partial<CachedHomeGitMetadata> = {}): CachedHomeGitMetadata {
	return {
		summary: null,
		conflictState: null,
		stashCount: 3,
		stateToken: "old-token",
		stateVersion: 1,
		...overrides,
	};
}

describe("loadHomeGitMetadata", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the previous stash count instead of publishing a false zero when the count is indeterminate", async () => {
		mocks.probeGitWorkdirState.mockResolvedValue({ stateToken: "old-token" });
		// `stashCount` returns `null` for an indeterminate result (e.g. a timeout
		// under load), never a bare `0` that would look like "no stashes".
		mocks.stashCount.mockResolvedValue(null);

		const previous = currentHomeGit({ stashCount: 3 });
		const result = await loadHomeGitMetadata("/repo", previous);

		expect(result.stashCount).toBe(3);
	});

	it("applies a fresh zero stash count when the probe genuinely found none", async () => {
		mocks.probeGitWorkdirState.mockResolvedValue({ stateToken: "old-token" });
		mocks.stashCount.mockResolvedValue(0);

		const previous = currentHomeGit({ stashCount: 3 });
		const result = await loadHomeGitMetadata("/repo", previous);

		expect(result.stashCount).toBe(0);
	});

	it("returns the previous metadata unchanged when the probe throws", async () => {
		mocks.probeGitWorkdirState.mockRejectedValue(new Error("Git did not respond in time; retry."));
		mocks.stashCount.mockResolvedValue(3);

		const previous = currentHomeGit({ stashCount: 3 });
		const result = await loadHomeGitMetadata("/repo", previous);

		expect(result).toBe(previous);
	});
});
