import pLimit from "p-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ProjectMetadataRemoteFetchPolicy,
	REMOTE_FETCH_INTERVAL_MS,
} from "../../../src/server/project-metadata-remote-fetch";

const workdirMocks = vi.hoisted(() => ({ runGit: vi.fn() }));

vi.mock("../../../src/workdir", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/workdir")>()),
	runGit: workdirMocks.runGit,
}));

function createPolicy() {
	return new ProjectMetadataRemoteFetchPolicy({
		getProjectPath: () => "/synthetic/repo",
		limitRemoteFetch: async (fetch) => await fetch(),
		onFetchSucceeded: async () => undefined,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	workdirMocks.runGit.mockReset();
	workdirMocks.runGit.mockResolvedValue({ ok: true, stdout: "", stderr: "", exitCode: 0 });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ProjectMetadataRemoteFetchPolicy cadence", () => {
	it("anchors a restarted interval to the last successful fetch", async () => {
		const policy = createPolicy();
		policy.requestFetch();
		await vi.advanceTimersByTimeAsync(0);
		expect(workdirMocks.runGit).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(REMOTE_FETCH_INTERVAL_MS - 10_000);
		policy.start();
		// The due fetch is not pushed a full interval out by the restart.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(workdirMocks.runGit).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(REMOTE_FETCH_INTERVAL_MS);
		expect(workdirMocks.runGit).toHaveBeenCalledTimes(3);
		policy.stop();
	});

	it("releases fetch admission before refreshing metadata after success", async () => {
		const limit = pLimit(1);
		let finishRefresh!: () => void;
		const refresh = new Promise<void>((resolve) => {
			finishRefresh = resolve;
		});
		const onFetchSucceeded = vi.fn(async () => {
			expect(limit.activeCount).toBe(0);
			await refresh;
		});
		const policy = new ProjectMetadataRemoteFetchPolicy({
			getProjectPath: () => "/synthetic/repo",
			limitRemoteFetch: async (fetch) => await limit(fetch),
			onFetchSucceeded,
		});
		try {
			policy.requestFetch();
			await vi.advanceTimersByTimeAsync(0);
			expect(onFetchSucceeded).toHaveBeenCalledOnce();
			expect(policy.getDiagnosticSnapshot().fetchInFlight).toBe(true);
			await expect(limit(async () => "next fetch")).resolves.toBe("next fetch");
		} finally {
			finishRefresh();
			await policy.waitForIdle();
		}
	});

	it("skips terminally disposed queued work without reporting a fetch result", async () => {
		const limit = pLimit(1);
		let release!: () => void;
		const blocker = limit(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await vi.advanceTimersByTimeAsync(0);
		const onFetchSucceeded = vi.fn();
		const onFetchCompleted = vi.fn();
		const policy = new ProjectMetadataRemoteFetchPolicy({
			getProjectPath: () => "/synthetic/repo",
			limitRemoteFetch: async (fetch) => await limit(fetch),
			onFetchSucceeded,
			onFetchCompleted,
		});
		policy.requestFetch();
		expect(limit.pendingCount).toBe(1);
		policy.dispose();
		release();
		await blocker;
		await policy.waitForIdle();
		policy.start();
		policy.requestFetch();
		await vi.advanceTimersByTimeAsync(REMOTE_FETCH_INTERVAL_MS);
		expect(workdirMocks.runGit).not.toHaveBeenCalled();
		expect(onFetchSucceeded).not.toHaveBeenCalled();
		expect(onFetchCompleted).not.toHaveBeenCalled();
		expect(policy.getDiagnosticSnapshot()).toMatchObject({
			timerActive: false,
			fetchInFlight: false,
			lastSucceeded: null,
			lastCompletedAt: null,
			lastErrorClass: null,
		});
	});

	it("keeps timer stop reversible and allows already queued fetches to drain", async () => {
		const limit = pLimit(1);
		let release!: () => void;
		const blocker = limit(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await vi.advanceTimersByTimeAsync(0);
		const policy = new ProjectMetadataRemoteFetchPolicy({
			getProjectPath: () => "/synthetic/repo",
			limitRemoteFetch: async (fetch) => await limit(fetch),
			onFetchSucceeded: async () => undefined,
		});
		policy.start();
		policy.requestFetch();
		policy.stop();
		release();
		await blocker;
		await policy.waitForIdle();
		expect(workdirMocks.runGit).toHaveBeenCalledOnce();
		policy.start();
		await vi.advanceTimersByTimeAsync(REMOTE_FETCH_INTERVAL_MS);
		expect(workdirMocks.runGit).toHaveBeenCalledTimes(2);
		policy.dispose();
	});

	it("drains an admitted fetch on disposal without starting post-fetch refresh", async () => {
		let finishFetch!: (result: { ok: boolean; stdout: string; stderr: string; exitCode: number }) => void;
		workdirMocks.runGit.mockReturnValue(
			new Promise((resolve) => {
				finishFetch = resolve;
			}),
		);
		const onFetchSucceeded = vi.fn();
		const onFetchCompleted = vi.fn();
		const policy = new ProjectMetadataRemoteFetchPolicy({
			getProjectPath: () => "/synthetic/repo",
			limitRemoteFetch: async (fetch) => await fetch(),
			onFetchSucceeded,
			onFetchCompleted,
		});
		policy.requestFetch();
		policy.dispose();
		let drained = false;
		const idle = policy.waitForIdle().then(() => {
			drained = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(drained).toBe(false);
		finishFetch({ ok: true, stdout: "", stderr: "", exitCode: 0 });
		await idle;
		expect(onFetchSucceeded).not.toHaveBeenCalled();
		expect(onFetchCompleted).toHaveBeenCalledOnce();
	});

	it("does not let a failed fetch defer the next requested fetch", async () => {
		const policy = createPolicy();
		workdirMocks.runGit.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "synthetic", exitCode: 1 });
		policy.requestFetch();
		await vi.advanceTimersByTimeAsync(0);
		policy.requestFetch();
		await vi.advanceTimersByTimeAsync(0);
		expect(workdirMocks.runGit).toHaveBeenCalledTimes(2);
		// A success now defers the next request for one interval.
		policy.requestFetch();
		await vi.advanceTimersByTimeAsync(0);
		expect(workdirMocks.runGit).toHaveBeenCalledTimes(2);
	});
});
