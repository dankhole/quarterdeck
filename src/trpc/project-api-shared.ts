import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
	IProjectDataProvider,
	IRuntimeBroadcaster,
	ITerminalManagerProvider,
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitMergeResponse,
	RuntimeWorkdirChangesMode,
	TaskResourceOperationRunner,
} from "../core";
import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import { loadProjectState } from "../state";
import type { AutomaticTitleGenerationRunner } from "../title";
import { isMissingTaskWorktreeError, resolveTaskWorkingDirectory } from "../workdir";
import { applyRuntimeMutationEffects } from "./runtime-mutation-effects";

const log = createTaggedLogger("project-api-effects");
export const GIT_DIAGNOSTIC_SLOW_MS = 2_000;

// ── Dependencies ────────────────────────────────────────────────────────────────

export interface CreateProjectApiDependencies {
	terminals: ITerminalManagerProvider;
	broadcaster: Pick<
		IRuntimeBroadcaster,
		| "broadcastRuntimeProjectStateUpdated"
		| "broadcastRuntimeProjectNotificationsUpdated"
		| "broadcastRuntimeProjectsUpdated"
		| "broadcastTaskTitleUpdated"
		| "setFocusedTask"
		| "setDocumentVisible"
		| "requestTaskRefresh"
		| "requestHomeRefresh"
	>;
	data: Pick<IProjectDataProvider, "buildProjectStateSnapshot">;
	diagnostics?: RuntimeDiagnostics;
	taskResourceOperations: TaskResourceOperationRunner;
	automaticTitleGeneration: AutomaticTitleGenerationRunner;
}

// ── Shared context ──────────────────────────────────────────────────────────────

export interface ProjectApiContext {
	deps: CreateProjectApiDependencies;
	applyEffects: (effects: Parameters<typeof applyRuntimeMutationEffects>[1]) => void;
}

export function createProjectApiContext(deps: CreateProjectApiDependencies): ProjectApiContext {
	const applyEffects = (effects: Parameters<typeof applyRuntimeMutationEffects>[1]) => {
		void applyRuntimeMutationEffects(deps.broadcaster, effects).catch((error) => {
			log.error("Failed to deliver project mutation effects", {
				error: errorMessage(error),
				effectTypes: effects.map((effect) => effect.type),
			});
		});
	};

	return { deps, applyEffects };
}

function diagnosticOperationOutcome(result: unknown): "succeeded" | "conflict" | "rejected" | "completed" {
	if (typeof result !== "object" || result === null || !("ok" in result) || typeof result.ok !== "boolean") {
		return "completed";
	}
	if ("pushOk" in result && result.pushOk === false) return "rejected";
	if (result.ok) return "succeeded";
	if ("conflictState" in result && result.conflictState !== null && result.conflictState !== undefined)
		return "conflict";
	if ("conflicted" in result && result.conflicted === true) return "conflict";
	return "rejected";
}

export async function observeProjectOperation<T>(
	ctx: ProjectApiContext,
	projectScope: { projectId: string },
	operation: string,
	options: { taskId?: string | null },
	perform: () => Promise<T>,
): Promise<T> {
	const operationId = randomUUID();
	const context = {
		projectId: projectScope.projectId,
		...(options.taskId ? { taskId: options.taskId } : {}),
		operationId,
	};
	const startedAt = Date.now();
	ctx.deps.diagnostics?.recordEvent("git.operation_started", { operation }, context, { essential: false });
	try {
		const result = await perform();
		const outcome = diagnosticOperationOutcome(result);
		const durationMs = Date.now() - startedAt;
		const abnormal = outcome === "rejected" || outcome === "conflict";
		const slow = durationMs >= GIT_DIAGNOSTIC_SLOW_MS;
		ctx.deps.diagnostics?.recordEvent(
			slow && !abnormal ? "git.operation_slow" : "git.operation_completed",
			{ operation, outcome, durationMs },
			context,
			{ level: abnormal || slow ? "warn" : "info", essential: abnormal || slow },
		);
		return result;
	} catch (error) {
		ctx.deps.diagnostics?.recordEvent(
			"git.operation_failed",
			{
				operation,
				durationMs: Date.now() - startedAt,
				errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
			},
			context,
			{ level: "error", essential: true },
		);
		throw error;
	}
}

// ── Constants ───────────────────────────────────────────────────────────────────

export const EMPTY_GIT_SUMMARY = {
	currentBranch: null,
	upstreamBranch: null,
	changedFiles: 0,
	additions: 0,
	deletions: 0,
	aheadCount: 0,
	behindCount: 0,
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────────

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isProjectCheckoutCwd(projectPath: string, cwd: string): boolean {
	return resolve(cwd) === resolve(projectPath);
}

export async function resolveWorkingDir(
	projectPath: string,
	taskScope: { taskId: string; baseRef: string } | null,
): Promise<string> {
	if (!taskScope) return projectPath;
	return await resolveTaskWorkingDirectory({ projectPath, ...taskScope });
}

export async function tryResolveTaskCwd(projectPath: string, taskId: string, baseRef: string): Promise<string | null> {
	try {
		return await resolveTaskWorkingDirectory({ projectPath, taskId, baseRef });
	} catch (error) {
		if (isMissingTaskWorktreeError(error)) return null;
		throw error;
	}
}

export async function hasActiveSharedCheckoutTask(projectPath: string): Promise<boolean> {
	const state = await loadProjectState(projectPath);
	const activeColumnIds = new Set(["in_progress", "review"]);
	return state.board.columns
		.filter((col) => activeColumnIds.has(col.id))
		.some((col) =>
			col.cards.some((card) => {
				const isSharedCheckout = card.workingDirectory
					? isProjectCheckoutCwd(projectPath, card.workingDirectory)
					: card.useWorktree === false;
				return isSharedCheckout;
			}),
		);
}

// ── Input normalization ─────────────────────────────────────────────────────────

export function normalizeOptionalTaskScopeInput(
	input: { taskId: string; baseRef: string } | null,
): { taskId: string; baseRef: string } | null {
	if (!input) return null;
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId) {
		throw new Error("taskScope query parameter requires taskId.");
	}
	return { taskId, baseRef };
}

export function normalizeRequiredTaskScopeInput(input: {
	taskId: string | null;
	baseRef?: string;
	mode?: RuntimeWorkdirChangesMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkdirChangesMode;
} {
	const taskId = (input.taskId ?? "").trim();
	const baseRef = (input.baseRef ?? "").trim();
	if (!taskId) throw new Error("Missing taskId query parameter.");
	if (!baseRef) throw new Error("Missing baseRef query parameter.");
	return { taskId, baseRef, mode: input.mode ?? "working_copy" };
}

// ── Error response factories ────────────────────────────────────────────────────

export function createGitBranchErrorResponse(error: unknown): RuntimeGitCheckoutResponse & RuntimeGitMergeResponse {
	return { ok: false, branch: "", summary: { ...EMPTY_GIT_SUMMARY }, output: "", error: errorMessage(error) };
}

export function createGitOutputErrorResponse(error: unknown): RuntimeGitDiscardResponse & RuntimeGitCommitResponse {
	return { ok: false, summary: { ...EMPTY_GIT_SUMMARY }, output: "", error: errorMessage(error) };
}
