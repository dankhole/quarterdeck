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
