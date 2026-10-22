import { describe, expect, it, vi } from "vitest";

import type { GitRepositoryProbeResult } from "../../../src/projects/git-repository-probe";
import { ProjectAvailabilityObserver } from "../../../src/projects/project-availability-observer";
import type { RuntimeProjectScopeContext } from "../../../src/state";

function scope(repoPath: string, metadataRevision = 0): RuntimeProjectScopeContext {
	return {
		projectId: "synthetic-project",
		repoPath,
		statePath: "/synthetic/state",
		metadataRevision,
	} as RuntimeProjectScopeContext;
}

function createObserver(options: { ttlMs?: number; retryDelaysMs?: readonly number[] } = {}) {
	let current: RuntimeProjectScopeContext | null = scope("/synthetic/a");
	const results: GitRepositoryProbeResult[] = [];
	const probeGitRepository = vi.fn(
		async (_path: string, _projectId: string): Promise<GitRepositoryProbeResult> => results.shift() ?? "repository",
	);
	const touchIndex = vi.fn(async () => ({ metadataRevision: (current?.metadataRevision ?? 0) + 1 }));
	const onAvailabilityChanged = vi.fn();
	const observer = new ProjectAvailabilityObserver({
		loadScope: async () => current,
		pathIsDirectory: async () => true,
		probeGitRepository,
		touchIndex,
		onAvailabilityChanged,
		gitProbeCacheTtlMs: options.ttlMs ?? 10_000,
		gitProbeRetryDelaysMs: options.retryDelaysMs ?? [],
	});
	return {
		observer,
		results,
		probeGitRepository,
		touchIndex,
		onAvailabilityChanged,
		setScope: (next: RuntimeProjectScopeContext | null) => {
			current = next;
		},
	};
}

describe("ProjectAvailabilityObserver", () => {
	it("keeps the last definite answer and leaves the index alone when Git cannot answer", async () => {
		const fixture = createObserver();
		await expect(fixture.observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({
			availability: { status: "available" },
			changed: false,
		});
		fixture.results.push("not_repository");
		await expect(fixture.observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({
			availability: { status: "unavailable", reason: "not_git_repository" },
			changed: true,
		});
		fixture.results.push("indeterminate");
		await expect(fixture.observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({
			availability: { status: "unavailable", reason: "not_git_repository" },
			indeterminate: true,
			changed: false,
		});
		expect(fixture.touchIndex).toHaveBeenCalledTimes(1);
	});

	it("drops an observation whose location changed before it was recorded", async () => {
		const fixture = createObserver();
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		fixture.probeGitRepository.mockImplementationOnce(async () => {
			await gate;
			return "not_repository";
		});
		const observation = fixture.observer.observe("synthetic-project", "fresh");
		await vi.waitFor(() => expect(fixture.probeGitRepository).toHaveBeenCalledOnce());
		fixture.setScope(scope("/synthetic/b"));
		release();
		const result = await observation;
		// The stale "not_repository" for the old path was neither recorded nor touched; the
		// retry observed the new location.
		expect(result).toMatchObject({ scope: { repoPath: "/synthetic/b" }, availability: { status: "available" } });
		expect(fixture.touchIndex).not.toHaveBeenCalled();
		expect(fixture.probeGitRepository.mock.calls.map(([path]) => path)).toEqual(["/synthetic/a", "/synthetic/b"]);
	});

	it("serves list-style reads from the last answer after the reuse window lapses", async () => {
		const fixture = createObserver({ ttlMs: 0 });
		await fixture.observer.observe("synthetic-project", "lastKnown");
		await fixture.observer.observe("synthetic-project", "lastKnown");
		expect(fixture.probeGitRepository).toHaveBeenCalledTimes(1);
		await fixture.observer.observe("synthetic-project", "cached");
		expect(fixture.probeGitRepository).toHaveBeenCalledTimes(2);
	});

	it("forgets previous-location evidence on reset", async () => {
		const fixture = createObserver();
		fixture.results.push("not_repository");
		await fixture.observer.observe("synthetic-project", "fresh");
		expect(fixture.touchIndex).toHaveBeenCalledTimes(1);
		fixture.observer.reset("synthetic-project");
		fixture.results.push("indeterminate");
		// Without its previous observation, an indeterminate answer is provisional.
		await expect(fixture.observer.observe("synthetic-project", "cached")).resolves.toMatchObject({
			availability: { status: "available" },
			indeterminate: true,
		});
	});

	it("fences background re-probes so they cannot touch the index", async () => {
		const fixture = createObserver({ retryDelaysMs: [20] });
		await fixture.observer.observe("synthetic-project", "fresh");
		fixture.results.push("indeterminate", "not_repository");
		await fixture.observer.observe("synthetic-project", "fresh");
		fixture.observer.fence("synthetic-project");
		await new Promise((resolveWait) => setTimeout(resolveWait, 60));
		expect(fixture.touchIndex).not.toHaveBeenCalled();
		expect(fixture.onAvailabilityChanged).not.toHaveBeenCalled();

		fixture.observer.unfence("synthetic-project");
		fixture.results.splice(0);
		fixture.results.push("indeterminate", "not_repository");
		await fixture.observer.observe("synthetic-project", "fresh");
		await vi.waitFor(() => expect(fixture.onAvailabilityChanged).toHaveBeenCalledWith("synthetic-project"));
		expect(fixture.touchIndex).toHaveBeenCalledTimes(1);
		fixture.observer.close();
	});

	it("carries only a Git-level verdict across a Git-stage indeterminate", async () => {
		let directoryExists = false;
		const results: GitRepositoryProbeResult[] = [];
		const touchIndex = vi.fn(async () => ({}));
		const observer = new ProjectAvailabilityObserver({
			loadScope: async () => scope("/synthetic/a"),
			pathIsDirectory: async () => directoryExists,
			probeGitRepository: async () => results.shift() ?? "repository",
			touchIndex,
			gitProbeRetryDelaysMs: [],
		});
		// `pathIsDirectory` false falls back to a real stat of a synthetic path: missing.
		await expect(observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({
			availability: { status: "unavailable", reason: "missing" },
		});
		directoryExists = true;
		results.push("indeterminate");
		// The folder check passed, which disproves "missing"; only the provisional answer remains.
		await expect(observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({
			availability: { status: "available" },
			indeterminate: true,
			changed: false,
		});
		expect(touchIndex).toHaveBeenCalledTimes(1);
	});

	it("seeds startup evidence without touching the index or replacing a recorded observation", async () => {
		const fixture = createObserver();
		await fixture.observer.seed("synthetic-project", scope("/synthetic/a"), {
			status: "unavailable",
			reason: "not_git_repository",
		});
		fixture.results.push("indeterminate");
		await expect(fixture.observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({
			availability: { status: "unavailable", reason: "not_git_repository" },
			indeterminate: true,
		});
		fixture.results.push("repository");
		await expect(fixture.observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({
			availability: { status: "available" },
			changed: true,
		});
		await fixture.observer.seed("synthetic-project", scope("/synthetic/a"), {
			status: "unavailable",
			reason: "not_git_repository",
		});
		fixture.results.push("indeterminate");
		await expect(fixture.observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({
			availability: { status: "available" },
		});
		expect(fixture.touchIndex).toHaveBeenCalledTimes(1);
	});

	it("treats descriptor exhaustion as indeterminate", async () => {
		const fixture = createObserver();
		await fixture.observer.observe("synthetic-project", "fresh");
		const exhausted = new SyntheticFilesystemError("EMFILE");
		const observer = new ProjectAvailabilityObserver({
			loadScope: async () => scope("/synthetic/a"),
			pathIsDirectory: async () => {
				throw exhausted;
			},
			probeGitRepository: async () => "repository",
			touchIndex: fixture.touchIndex,
		});
		await expect(observer.observe("synthetic-project", "fresh")).resolves.toMatchObject({ indeterminate: true });
		expect(fixture.touchIndex).not.toHaveBeenCalled();
	});
});

class SyntheticFilesystemError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}
