import type { RuntimeProjectStateResponse } from "../core";
import { createTaggedLogger } from "../core";
import type { ProjectStatePublicationPreparation } from "./project-registry";

const log = createTaggedLogger("project-state-publication");

/**
 * Backoff between attempts when index metadata advanced while a publication was
 * being enriched. Its length bounds the retries; an empty list never retries.
 */
export const PROJECT_STATE_PUBLICATION_RETRY_DELAYS_MS: readonly number[] = [50, 200, 500, 1_000];

export interface ProjectStatePublicationSchedulerDependencies {
	/** Metadata-only enrichment. Must not acquire project admission or hydrate a session manager. */
	prepare: (projectId: string, state: RuntimeProjectStateResponse) => Promise<ProjectStatePublicationPreparation>;
	publish: (projectId: string, state: RuntimeProjectStateResponse) => void;
	retryDelaysMs?: readonly number[];
	onPublicationDropped?: (projectId: string, reason: "superseded" | "retries_exhausted") => void;
}

interface ProjectPublicationLane {
	/** Highest-revision committed state awaiting publication. */
	pending: RuntimeProjectStateResponse | null;
	running: Promise<void> | null;
	retryTimer: NodeJS.Timeout | null;
	retryAttempt: number;
	lastPublishedRevision: number;
	drained: boolean;
}

/**
 * Publishes committed project state to browsers after the commit has returned.
 *
 * Mechanism: enrich a committed state with location, availability, and Git
 * metadata, then broadcast it. Policy: one run per project at a time, and the
 * highest-revision committed state wins, so a burst of commits costs one
 * enrichment. Publication never re-reads disk (persisted sessions trail the
 * live store) and never publishes a lower revision than it already published.
 */
export class ProjectStatePublicationScheduler {
	private readonly lanes = new Map<string, ProjectPublicationLane>();
	private readonly retryDelaysMs: readonly number[];
	private closed = false;

	constructor(private readonly deps: ProjectStatePublicationSchedulerDependencies) {
		this.retryDelaysMs = deps.retryDelaysMs ?? PROJECT_STATE_PUBLICATION_RETRY_DELAYS_MS;
	}

	/** Records a committed state for publication and returns immediately. */
	schedule(projectId: string, state: RuntimeProjectStateResponse): void {
		if (this.closed) return;
		const lane = this.getLane(projectId);
		if (lane.drained) return;
		if (state.revision < lane.lastPublishedRevision) return;
		if (lane.pending && state.revision < lane.pending.revision) return;
		lane.pending = state;
		// A new commit supersedes any backoff for the previous one.
		if (lane.retryTimer) {
			clearTimeout(lane.retryTimer);
			lane.retryTimer = null;
			lane.retryAttempt = 0;
		}
		this.kick(projectId, lane);
	}

	/**
	 * Cancels pending work for a project, waits for an in-flight run, and drops
	 * later schedules until `releaseProject`. Relocation and removal call this so
	 * no publication observes or touches the project mid-change.
	 */
	async drainProject(projectId: string): Promise<void> {
		const lane = this.getLane(projectId);
		lane.drained = true;
		this.cancel(lane);
		await lane.running;
	}

	/** Re-admits publications after a drain; later commits publish normally. */
	releaseProject(projectId: string): void {
		const lane = this.lanes.get(projectId);
		if (!lane || lane.running) {
			if (lane) lane.drained = false;
			return;
		}
		this.lanes.delete(projectId);
	}

	async close(): Promise<void> {
		this.closed = true;
		const running: Promise<void>[] = [];
		for (const lane of this.lanes.values()) {
			lane.drained = true;
			this.cancel(lane);
			if (lane.running) running.push(lane.running);
		}
		await Promise.allSettled(running);
	}

	/** Waits for in-flight runs; a scheduled backoff retry is not awaited. */
	async waitForIdle(): Promise<void> {
		for (;;) {
			const running = Array.from(this.lanes.values()).flatMap((lane) => (lane.running ? [lane.running] : []));
			if (running.length === 0) return;
			await Promise.allSettled(running);
		}
	}

	private getLane(projectId: string): ProjectPublicationLane {
		let lane = this.lanes.get(projectId);
		if (!lane) {
			lane = {
				pending: null,
				running: null,
				retryTimer: null,
				retryAttempt: 0,
				lastPublishedRevision: Number.NEGATIVE_INFINITY,
				drained: false,
			};
			this.lanes.set(projectId, lane);
		}
		return lane;
	}

	private cancel(lane: ProjectPublicationLane): void {
		lane.pending = null;
		lane.retryAttempt = 0;
		if (lane.retryTimer) {
			clearTimeout(lane.retryTimer);
			lane.retryTimer = null;
		}
	}

	private kick(projectId: string, lane: ProjectPublicationLane): void {
		if (lane.running || lane.retryTimer || !lane.pending || lane.drained || this.closed) return;
		const running = this.runOnce(projectId, lane)
			.catch((error: unknown) => {
				// A run never rejects into drain/close or an unhandled rejection.
				log.warn("committed project state publication run failed", {
					projectId,
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				lane.running = null;
				this.kick(projectId, lane);
			});
		lane.running = running;
	}

	private async runOnce(projectId: string, lane: ProjectPublicationLane): Promise<void> {
		const state = lane.pending;
		if (!state) return;
		lane.pending = null;
		let prepared: ProjectStatePublicationPreparation;
		try {
			prepared = await this.deps.prepare(projectId, state);
		} catch (error) {
			log.warn("committed project state publication failed", {
				projectId,
				revision: state.revision,
				error: error instanceof Error ? error.message : String(error),
			});
			this.retry(projectId, lane, state);
			return;
		}
		if (lane.drained || this.closed) return;
		if (prepared.status === "ready") {
			lane.retryAttempt = 0;
			// A newer commit queued meanwhile publishes on the next run.
			if (prepared.state.revision < lane.lastPublishedRevision) return;
			lane.lastPublishedRevision = prepared.state.revision;
			try {
				this.deps.publish(projectId, prepared.state);
			} catch (error) {
				// Broadcast failures are transport problems; the committed state stands
				// and the next publication or reconnect delivers it.
				log.warn("committed project state broadcast failed", {
					projectId,
					revision: prepared.state.revision,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		if (prepared.status === "superseded") {
			lane.retryAttempt = 0;
			this.deps.onPublicationDropped?.(projectId, "superseded");
			return;
		}
		this.retry(projectId, lane, state);
	}

	private retry(projectId: string, lane: ProjectPublicationLane, state: RuntimeProjectStateResponse): void {
		// Retry with the latest committed state, keeping a newer pending commit if one arrived.
		if (!lane.pending || lane.pending.revision < state.revision) lane.pending = state;
		const delay = this.retryDelaysMs[lane.retryAttempt];
		if (delay === undefined) {
			lane.retryAttempt = 0;
			lane.pending = null;
			log.warn("committed project state publication retries exhausted", { projectId, revision: state.revision });
			this.deps.onPublicationDropped?.(projectId, "retries_exhausted");
			return;
		}
		lane.retryAttempt += 1;
		lane.retryTimer = setTimeout(() => {
			lane.retryTimer = null;
			this.kick(projectId, lane);
		}, delay);
		lane.retryTimer.unref?.();
	}
}
