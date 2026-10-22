import type { TaskResourceOperationCoordinator } from "../core";

type RunProjectExclusive = TaskResourceOperationCoordinator["runProjectExclusive"];

export interface ProjectRelocationFailureResumeDependencies {
	/** Synchronous unfence/release steps; always run, before anything that can fail. */
	releaseFences: (projectId: string) => void;
	loadScope: (projectId: string) => Promise<{ repoPath: string } | null>;
	/** Re-announces a retained manager so persistence and the hub track it again. */
	reattachManager: (projectId: string, repoPath: string) => Promise<void>;
	refreshHub: (projectId: string, repoPath: string) => Promise<void>;
}

/**
 * Resumes a project's read paths for its saved location after a relocation
 * failed post-quiesce. Fences are released first and unconditionally; launches
 * stay gated by availability (a pending journal reads as relocation pending).
 */
export function createRelocationFailureResume(
	deps: ProjectRelocationFailureResumeDependencies,
): (projectId: string) => Promise<void> {
	return async (projectId) => {
		deps.releaseFences(projectId);
		const scope = await deps.loadScope(projectId);
		if (!scope) return;
		await deps.reattachManager(projectId, scope.repoPath);
		await deps.refreshHub(projectId, scope.repoPath);
	};
}

/**
 * Tracks relocation quiesce per project so a relocation that fails after
 * quiescing (but before its refresh) resumes the project instead of leaving
 * publication, background re-probes, and the stream hub suspended until restart.
 * The resume runs after the exclusive section is released.
 */
export class ProjectRelocationQuiesceGuard {
	private readonly quiesced = new Set<string>();

	constructor(
		private readonly runExclusive: RunProjectExclusive,
		private readonly resumeAfterFailure: (projectId: string) => Promise<void>,
		private readonly onResumeFailed: (projectId: string, error: unknown) => void,
	) {}

	markQuiesced(projectId: string): void {
		this.quiesced.add(projectId);
	}

	markRefreshed(projectId: string): void {
		this.quiesced.delete(projectId);
	}

	runProjectExclusive: RunProjectExclusive = async (projectId, operation) => {
		try {
			return await this.runExclusive(projectId, operation);
		} catch (error) {
			if (this.quiesced.delete(projectId)) {
				try {
					await this.resumeAfterFailure(projectId);
				} catch (resumeError) {
					// The relocation's own error stays the caller's result.
					this.onResumeFailed(projectId, resumeError);
				}
			}
			throw error;
		}
	};
}
