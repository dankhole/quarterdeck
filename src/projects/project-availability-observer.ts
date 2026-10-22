import type { RuntimeProjectAvailability } from "../core";
import { KeyedOperationCoordinator } from "../core/keyed-operation-coordinator";
import { areFileSystemPathsEqual } from "../core/path-comparison";
import type { RuntimeProjectScopeContext } from "../state";
import type { GitRepositoryProbeResult } from "./git-repository-probe";
import { GitRepositoryProbeCache, type GitRepositoryProbeReadOptions } from "./git-repository-probe-cache";
import { observeProjectAvailabilityDetailed, type ProjectAvailabilityScope } from "./project-availability";
import {
	previousAvailabilityForScope,
	projectAvailabilityScopeFingerprint,
	resolveIndeterminateAvailability,
	type StoredProjectAvailability,
} from "./project-availability-carry-forward";

/**
 * - `fresh`: probe Git again (explicit checks, rebind, launch admission).
 * - `cached`: accept the probe cache's reuse window (request scope checks, snapshots, publication).
 * - `lastKnown`: accept the last Git answer however old; probe only if none exists
 *   (project-list rebuilds, which must not spawn Git for every project).
 * Directory, identity, and relocation-journal checks run in every mode.
 */
export type ProjectAvailabilityReadMode = "fresh" | "cached" | "lastKnown";

export interface ProjectLocationObservation {
	scope: RuntimeProjectScopeContext | null;
	availability: RuntimeProjectAvailability;
	/** This observation had no definite answer; `availability` is carried forward or provisional. */
	indeterminate: boolean;
	/** This observation recorded a change and touched the project index. */
	changed: boolean;
}

export interface ProjectAvailabilityObserverDependencies {
	loadScope: (projectId: string) => Promise<RuntimeProjectScopeContext | null>;
	pathIsDirectory: (path: string) => Promise<boolean>;
	probeGitRepository: (path: string, projectId: string) => Promise<GitRepositoryProbeResult>;
	/** Advances the index metadata revision so clients order the availability change. */
	touchIndex: (projectId: string, expectedPath: string) => Promise<Partial<RuntimeProjectScopeContext>>;
	onScopeObserved?: (projectId: string, repoPath: string) => void;
	/** A background re-probe recorded an availability change. */
	onAvailabilityChanged?: (projectId: string) => void;
	gitProbeCacheTtlMs?: number;
	gitProbeRetryDelaysMs?: readonly number[];
}

const LOCATION_CHANGED = Symbol("location-changed");
const PROJECT_LOCATION_OBSERVATION_ATTEMPTS = 2;

/**
 * Owns runtime availability observation for registered projects: the last
 * definite observation per project scope, ordered recording and index touches,
 * the Git probe cache, and relocation fences. Indeterminate answers never mark a
 * project unavailable or touch the index; `project-availability-carry-forward`
 * decides which earlier verdict, if any, they report instead.
 */
export class ProjectAvailabilityObserver {
	private readonly observed = new Map<string, StoredProjectAvailability>();
	// Per-project lane that records observations and touches the index in order.
	// Probes run before entering it, so a slow probe never queues other readers.
	private readonly lanes = new KeyedOperationCoordinator();
	private readonly sequences = new Map<string, { started: number; recorded: number }>();
	// Relocation quiesce fences background re-probes so none touches the index mid-move.
	private readonly fenced = new Set<string>();
	private readonly gitProbes: GitRepositoryProbeCache;
	private closed = false;

	constructor(private readonly deps: ProjectAvailabilityObserverDependencies) {
		this.gitProbes = new GitRepositoryProbeCache({
			probe: deps.probeGitRepository,
			ttlMs: deps.gitProbeCacheTtlMs,
			retryDelaysMs: deps.gitProbeRetryDelaysMs,
			onRetryObserved: (projectId) => {
				if (this.closed || this.fenced.has(projectId)) return;
				void this.observe(projectId, "cached")
					.then(({ changed }) => {
						if (changed) deps.onAvailabilityChanged?.(projectId);
					})
					.catch(() => undefined);
			},
		});
	}

	async observe(projectId: string, mode: ProjectAvailabilityReadMode): Promise<ProjectLocationObservation> {
		for (let attempt = 1; ; attempt += 1) {
			const result = await this.observeOnce(projectId, mode);
			if (result !== LOCATION_CHANGED) return result;
			if (attempt >= PROJECT_LOCATION_OBSERVATION_ATTEMPTS) {
				// The location moved under every attempt: report no definite answer.
				return {
					scope: await this.deps.loadScope(projectId),
					availability: { status: "unavailable", reason: "relocation_pending" },
					indeterminate: true,
					changed: false,
				};
			}
		}
	}

	/** Drops Git answer reuse, e.g. after an explicit location change. */
	invalidate(projectId: string): void {
		this.gitProbes.invalidate(projectId);
	}

	/**
	 * The Git root probe behind every observation, with the same reuse rules.
	 * Startup validation probes through it so later startup reads reuse its answer.
	 */
	async probeGitRepository(
		projectId: string,
		path: string,
		mode: ProjectAvailabilityReadMode,
	): Promise<GitRepositoryProbeResult> {
		return await this.gitProbes.probe(projectId, path, this.gitReadOptions(mode));
	}

	/**
	 * Records a definite verdict observed outside `observe` (startup validation)
	 * as previous evidence, unless an observation was already recorded. It is
	 * startup's baseline, not a change, so it never touches the index.
	 */
	async seed(
		projectId: string,
		scope: ProjectAvailabilityScope,
		availability: RuntimeProjectAvailability,
	): Promise<void> {
		await this.lanes.run(projectId, async () => {
			if (this.closed || this.observed.has(projectId)) return;
			this.observed.set(projectId, { ...projectAvailabilityScopeFingerprint(scope), availability });
		});
	}

	/** Forgets every observation for a project's previous location (rebind). */
	reset(projectId: string): void {
		this.observed.delete(projectId);
		this.sequences.delete(projectId);
		this.gitProbes.invalidate(projectId);
	}

	/** Removes all state for a disposed project. */
	forget(projectId: string): void {
		this.reset(projectId);
		this.fenced.delete(projectId);
	}

	fence(projectId: string): void {
		this.fenced.add(projectId);
		this.gitProbes.invalidate(projectId);
	}

	unfence(projectId: string): void {
		this.fenced.delete(projectId);
	}

	close(): void {
		this.closed = true;
		this.gitProbes.close();
	}

	async waitForIdle(): Promise<void> {
		await this.gitProbes.waitForIdle();
		await this.lanes.waitForIdle();
	}

	private gitReadOptions(mode: ProjectAvailabilityReadMode): GitRepositoryProbeReadOptions {
		if (mode === "fresh") return { maxAgeMs: 0 };
		if (mode === "lastKnown") return { allowStale: true };
		return {};
	}

	private async observeOnce(
		projectId: string,
		mode: ProjectAvailabilityReadMode,
	): Promise<ProjectLocationObservation | typeof LOCATION_CHANGED> {
		const initialScope = await this.deps.loadScope(projectId);
		if (!initialScope) {
			return {
				scope: null,
				availability: { status: "unavailable", reason: "invalid_location" },
				indeterminate: false,
				changed: false,
			};
		}
		this.deps.onScopeObserved?.(projectId, initialScope.repoPath);
		const sequences = this.sequences.get(projectId) ?? { started: 0, recorded: 0 };
		this.sequences.set(projectId, sequences);
		sequences.started += 1;
		const sequence = sequences.started;
		const observation = await observeProjectAvailabilityDetailed(initialScope, {
			pathIsDirectory: this.deps.pathIsDirectory,
			probeGitRepository: (path) => this.gitProbes.probe(projectId, path, this.gitReadOptions(mode)),
		});
		return await this.lanes.run(projectId, async () => {
			// Revalidate the location inside the lane: an observation of a path the
			// project no longer has must never be recorded or touch the index.
			const current = await this.deps.loadScope(projectId);
			if (!current) {
				return {
					scope: null,
					availability: { status: "unavailable", reason: "invalid_location" },
					indeterminate: false,
					changed: false,
				} satisfies ProjectLocationObservation;
			}
			if (!areFileSystemPathsEqual(current.repoPath, initialScope.repoPath)) return LOCATION_CHANGED;
			// Report the scope this observation started from, so callers comparing
			// metadata revisions still detect index changes made while it ran.
			let scope = initialScope;
			const previous = previousAvailabilityForScope(this.observed.get(projectId), scope);
			if (observation.indeterminate) {
				const { availability } = resolveIndeterminateAvailability(
					previous,
					observation.indeterminate,
					observation.availability,
				);
				return { scope, availability, indeterminate: true, changed: false };
			}
			const availability = observation.availability;
			// Background readers never touch the index for an in-progress relocation;
			// its commit owns the next metadata revision.
			if (
				mode !== "fresh" &&
				availability.status === "unavailable" &&
				availability.reason === "relocation_pending"
			) {
				return { scope, availability, indeterminate: false, changed: false };
			}
			// An observation that started before an already-recorded one is older evidence.
			if (this.sequences.get(projectId) !== sequences || sequence < sequences.recorded) {
				return { scope, availability, indeterminate: false, changed: false };
			}
			sequences.recorded = sequence;
			const changed = previous
				? JSON.stringify(previous) !== JSON.stringify(availability)
				: availability.status === "unavailable";
			if (changed) scope = { ...scope, ...(await this.deps.touchIndex(projectId, scope.repoPath)) };
			this.observed.set(projectId, { ...projectAvailabilityScopeFingerprint(scope), availability });
			return { scope, availability, indeterminate: false, changed };
		});
	}
}
