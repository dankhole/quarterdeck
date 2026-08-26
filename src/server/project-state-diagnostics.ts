import { type DiagnosticCaptureScope, getRuntimeSessionWorkColumn, type RuntimeProjectStateResponse } from "../core";

export interface ProjectStateSessionColumnDivergence {
	taskId: string;
	sessionState: RuntimeProjectStateResponse["sessions"][string]["state"];
	actualColumnId: "in_progress" | "review";
	expectedColumnId: "in_progress" | "review";
}

export interface ProjectStateDiagnosticSummary {
	projectId: string;
	revision: number;
	cardCounts: Record<string, number>;
	sessionCount: number;
	sessionColumnDivergences: ProjectStateSessionColumnDivergence[];
	lastObservedAt: number;
}

interface TrackedProjectStateDiagnostics {
	summary: ProjectStateDiagnosticSummary;
	taskColumnById: Map<string, string>;
	sessionTaskIds: Set<string>;
}

/**
 * Read-only diagnostic projection owned by the project-state boundary.
 *
 * This is deliberately an observation cache, not a second source of project
 * truth. It is updated only when the registry has already built an
 * authoritative state response and never loads, repairs, or persists state on
 * behalf of a diagnostic consumer.
 */
export class ProjectStateDiagnosticTracker {
	private readonly states = new Map<string, TrackedProjectStateDiagnostics>();

	observe(projectId: string, state: RuntimeProjectStateResponse): void {
		const columnByTaskId = new Map(
			state.board.columns.flatMap((column) => column.cards.map((card) => [card.id, column.id] as const)),
		);
		const sessionColumnDivergences: ProjectStateSessionColumnDivergence[] = [];
		for (const summary of Object.values(state.sessions)) {
			const expectedColumnId = getRuntimeSessionWorkColumn(summary);
			const actualColumnId = columnByTaskId.get(summary.taskId);
			if (
				expectedColumnId &&
				(actualColumnId === "in_progress" || actualColumnId === "review") &&
				actualColumnId !== expectedColumnId
			) {
				sessionColumnDivergences.push({
					taskId: summary.taskId,
					sessionState: summary.state,
					actualColumnId,
					expectedColumnId,
				});
			}
		}
		this.states.set(projectId, {
			summary: {
				projectId,
				revision: state.revision,
				cardCounts: Object.fromEntries(state.board.columns.map((column) => [column.id, column.cards.length])),
				sessionCount: Object.keys(state.sessions).length,
				sessionColumnDivergences,
				lastObservedAt: Date.now(),
			},
			taskColumnById: columnByTaskId,
			sessionTaskIds: new Set(Object.keys(state.sessions)),
		});
	}

	remove(projectId: string): void {
		this.states.delete(projectId);
	}

	getSnapshot(scope: Readonly<DiagnosticCaptureScope> = {}): { projects: ProjectStateDiagnosticSummary[] } {
		return {
			projects: Array.from(this.states.values())
				.filter(
					(state) =>
						(!scope.projectId || state.summary.projectId === scope.projectId) &&
						(!scope.taskId ||
							Boolean(scope.projectId) ||
							state.taskColumnById.has(scope.taskId) ||
							state.sessionTaskIds.has(scope.taskId)),
				)
				.map((state) => ({
					...structuredClone(state.summary),
					...(scope.taskId
						? {
								cardCounts: state.taskColumnById.has(scope.taskId)
									? { [state.taskColumnById.get(scope.taskId) ?? "unknown"]: 1 }
									: {},
								sessionCount: Number(state.sessionTaskIds.has(scope.taskId)),
							}
						: undefined),
					sessionColumnDivergences: state.summary.sessionColumnDivergences.filter(
						(divergence) => !scope.taskId || divergence.taskId === scope.taskId,
					),
				})),
		};
	}
}
