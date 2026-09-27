import { initTRPC, TRPCError } from "@trpc/server";

import { loadProjectScopeById } from "../state";

import type { RuntimeTrpcContext, RuntimeTrpcContextWithProjectScope } from "./app-router-context";

function readConflictRevision(cause: unknown): number | null {
	if (!cause || typeof cause !== "object" || !("currentRevision" in cause)) {
		return null;
	}
	const revision = (cause as { currentRevision?: unknown }).currentRevision;
	if (typeof revision !== "number") {
		return null;
	}
	return Number.isFinite(revision) ? revision : null;
}

export const t = initTRPC.context<RuntimeTrpcContext>().create({
	errorFormatter({ shape, error }) {
		const conflictRevision = error.code === "CONFLICT" ? readConflictRevision(error.cause) : null;
		return {
			...shape,
			data: {
				...shape.data,
				conflictRevision,
			},
		};
	},
});

export const projectProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.requestedProjectId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Missing project scope. Include x-quarterdeck-project-id header or projectId query parameter.",
		});
	}
	if (!ctx.projectScope) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Unknown project ID: ${ctx.requestedProjectId}`,
		});
	}
	return next({
		ctx: {
			...ctx,
			projectScope: ctx.projectScope,
		} satisfies RuntimeTrpcContextWithProjectScope,
	});
});

/** Folder projects never operate on an incidental ancestor or placeholder repository. */
export const projectGitProcedure = projectProcedure.use(async ({ ctx, next }) => {
	if ((await loadProjectScopeById(ctx.projectScope.projectId))?.folderOnly) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Git is disabled for this folder project. Open a child Git project instead.",
		});
	}
	return next();
});
