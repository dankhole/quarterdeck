// Persists authoritative terminal-store changes independently of runtime streaming.
// Hook ingestion uses explicit generation barriers before acknowledging durability.

import { createTaggedLogger } from "../core";
import type { ProjectBoardCommandService } from "../state";
import type { TerminalSessionManager } from "../terminal";
import type { ProjectRegistry } from "./project-registry";

const persistenceLog = createTaggedLogger("runtime-session-persistence");
const SESSION_PERSISTENCE_RETRY_MAX_MS = 5_000;
const SESSION_PERSISTENCE_FINAL_ATTEMPTS = 2;

interface RuntimeSessionPersistenceState {
	dirtyGeneration: number;
	persistedGeneration: number;
	retryAttempt: number;
	lastError: Error | null;
	timer: ReturnType<typeof setTimeout> | null;
	inFlight: Promise<void> | null;
	disposed: boolean;
}

export interface RuntimeSessionPersistenceDependencies {
	projectRegistry: Pick<ProjectRegistry, "getProjectPathById">;
	boardCommands: Pick<ProjectBoardCommandService, "reconcileRuntimeSessions">;
}

export class RuntimeSessionPersistence {
	private readonly sessionPersistenceUnsubscribes = new Map<string, () => void>();
	private readonly sessionPersistenceStates = new Map<string, RuntimeSessionPersistenceState>();
	private readonly sessionPersistenceBarriers = new Set<Promise<void>>();
	private sessionPersistenceClosed = false;

	constructor(private readonly deps: RuntimeSessionPersistenceDependencies) {}

	trackTerminalManager = (projectId: string, manager: TerminalSessionManager): void => {
		if (this.sessionPersistenceClosed) {
			throw new Error("Runtime session persistence is closed.");
		}
		if (this.sessionPersistenceUnsubscribes.has(projectId)) {
			return;
		}
		const persist = () => this.scheduleRuntimeSessionPersistence(projectId);
		this.sessionPersistenceUnsubscribes.set(projectId, manager.store.onChange(persist));
		if (manager.store.listSummaries().length > 0) {
			this.scheduleRuntimeSessionPersistence(projectId, 0);
		}
	};

	persistRuntimeSessions = (projectId: string): Promise<void> => {
		if (this.sessionPersistenceClosed) {
			return Promise.reject(new Error("Runtime session persistence is closed."));
		}
		const persistence = (async () => {
			// Explicit persistence is also a write barrier. Mark a fresh generation so
			// callers that run after the automatic store listener has been detached
			// still capture the current session snapshot before they resolve.
			this.scheduleRuntimeSessionPersistence(projectId, 0);
			await this.flushRuntimeSessionPersistence(projectId);
		})();
		const tracked = persistence.finally(() => this.sessionPersistenceBarriers.delete(tracked));
		this.sessionPersistenceBarriers.add(tracked);
		return tracked;
	};

	disposeProject = async (projectId: string): Promise<void> => {
		this.unsubscribeRuntimeSessionPersistence(projectId);
		const state = this.sessionPersistenceStates.get(projectId);
		if (state) {
			state.disposed = true;
			if (state.timer) clearTimeout(state.timer);
			state.timer = null;
			// Remove the old generation before awaiting so a legitimate re-add can
			// install a fresh writer without inheriting disposed state.
			this.sessionPersistenceStates.delete(projectId);
			if (state.inFlight) await state.inFlight;
		}
	};

	close = async (): Promise<void> => {
		const trackedProjectIds = Array.from(this.sessionPersistenceUnsubscribes.keys());
		for (const projectId of trackedProjectIds) {
			this.unsubscribeRuntimeSessionPersistence(projectId);
		}
		const persistenceResults = await Promise.allSettled(
			trackedProjectIds.map(async (projectId) => await this.flushRuntimeSessionPersistence(projectId)),
		);
		const barrierResults: PromiseSettledResult<void>[] = [];
		while (this.sessionPersistenceBarriers.size > 0) {
			barrierResults.push(...(await Promise.allSettled(Array.from(this.sessionPersistenceBarriers))));
		}
		// No asynchronous gap exists between observing an empty barrier set and
		// closing admission, so a later acknowledgement fails closed instead of
		// reporting durability after its writer has been disposed.
		this.sessionPersistenceClosed = true;
		const persistenceProjectIds = Array.from(this.sessionPersistenceStates.keys());
		await Promise.all(persistenceProjectIds.map(async (projectId) => await this.disposeProject(projectId)));
		const persistenceFailures = [...persistenceResults, ...barrierResults].flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (persistenceFailures.length > 0) {
			throw new AggregateError(persistenceFailures, "Runtime session persistence did not finish during shutdown.");
		}
	};

	private scheduleRuntimeSessionPersistence(projectId: string, delayMs = 100): void {
		let state = this.sessionPersistenceStates.get(projectId);
		if (!state) {
			state = {
				dirtyGeneration: 0,
				persistedGeneration: 0,
				retryAttempt: 0,
				lastError: null,
				timer: null,
				inFlight: null,
				disposed: false,
			};
			this.sessionPersistenceStates.set(projectId, state);
		}
		if (state.disposed) return;
		state.dirtyGeneration += 1;
		this.armRuntimeSessionPersistence(projectId, state, delayMs);
	}

	private armRuntimeSessionPersistence(
		projectId: string,
		state: RuntimeSessionPersistenceState,
		delayMs: number,
	): void {
		if (state.disposed || state.inFlight) return;
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = null;
			void this.runRuntimeSessionPersistence(projectId, state);
		}, delayMs);
		state.timer.unref?.();
	}

	private async runRuntimeSessionPersistence(
		projectId: string,
		state: RuntimeSessionPersistenceState,
		options: { retry?: boolean } = {},
	): Promise<void> {
		if (state.disposed || state.persistedGeneration >= state.dirtyGeneration) return;
		if (state.inFlight) {
			await state.inFlight;
			return;
		}
		const targetGeneration = state.dirtyGeneration;
		let succeeded = false;
		state.inFlight = (async () => {
			const projectPath = this.deps.projectRegistry.getProjectPathById(projectId);
			if (!projectPath) throw new Error("Project path is unavailable for runtime session persistence.");
			await this.deps.boardCommands.reconcileRuntimeSessions({ projectId, projectPath });
			succeeded = true;
			state.persistedGeneration = Math.max(state.persistedGeneration, targetGeneration);
			state.retryAttempt = 0;
			state.lastError = null;
		})()
			.catch((error) => {
				state.retryAttempt += 1;
				state.lastError = error instanceof Error ? error : new Error(String(error));
				persistenceLog.warn("runtime session persistence failed", {
					projectId,
					dirtyGeneration: state.dirtyGeneration,
					persistedGeneration: state.persistedGeneration,
					retryAttempt: state.retryAttempt,
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				state.inFlight = null;
			});
		await state.inFlight;
		if (state.disposed || this.sessionPersistenceStates.get(projectId) !== state) return;
		if (state.persistedGeneration < state.dirtyGeneration && options.retry !== false) {
			const retryDelay = succeeded
				? 0
				: Math.min(250 * 2 ** Math.max(0, state.retryAttempt - 1), SESSION_PERSISTENCE_RETRY_MAX_MS);
			this.armRuntimeSessionPersistence(projectId, state, retryDelay);
		}
	}

	private async flushRuntimeSessionPersistence(projectId: string): Promise<void> {
		const state = this.sessionPersistenceStates.get(projectId);
		if (!state || state.disposed) return;
		// A caller needs the generation that was dirty when it requested the
		// flush, not an unbounded stream of newer activity. Concurrent hook
		// acknowledgements may advance dirtyGeneration while this caller waits.
		const requiredGeneration = state.dirtyGeneration;
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		if (state.inFlight) await state.inFlight;
		for (
			let attempt = 0;
			attempt < SESSION_PERSISTENCE_FINAL_ATTEMPTS && state.persistedGeneration < requiredGeneration;
			attempt += 1
		) {
			await this.runRuntimeSessionPersistence(projectId, state, { retry: false });
		}
		if (state.persistedGeneration < requiredGeneration) {
			throw (
				state.lastError ??
				new Error(`Runtime session persistence did not reach the required generation for project "${projectId}".`)
			);
		}
	}

	private unsubscribeRuntimeSessionPersistence(projectId: string): void {
		const unsubscribe = this.sessionPersistenceUnsubscribes.get(projectId);
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// Listener cleanup must not prevent bounded shutdown persistence.
			}
		}
		this.sessionPersistenceUnsubscribes.delete(projectId);
	}
}
