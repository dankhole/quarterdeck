import type { RuntimeTrpcContext } from "./app-router-context";
import { createChangesOps } from "./workspace-api-changes";
import { createConflictOps } from "./workspace-api-conflict";
import { createGitOps } from "./workspace-api-git-ops";
import { type CreateWorkspaceApiDependencies, createWorkspaceApiContext } from "./workspace-api-shared";
import { createStagingOps } from "./workspace-api-staging";
import { createStateOps } from "./workspace-api-state";

export type { CreateWorkspaceApiDependencies } from "./workspace-api-shared";

export function createWorkspaceApi(deps: CreateWorkspaceApiDependencies): RuntimeTrpcContext["workspaceApi"] {
	const ctx = createWorkspaceApiContext(deps);

	return {
		...createGitOps(ctx),
		...createConflictOps(ctx),
		...createStagingOps(ctx),
		...createChangesOps(ctx),
		...createStateOps(ctx),
	};
}
