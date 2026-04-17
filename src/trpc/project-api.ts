import type { RuntimeTrpcContext } from "./app-router-context";
import { createChangesOps } from "./project-api-changes";
import { createConflictOps } from "./project-api-conflict";
import { createGitOps } from "./project-api-git-ops";
import { type CreateProjectApiDependencies, createProjectApiContext } from "./project-api-shared";
import { createStagingOps } from "./project-api-staging";
import { createStateOps } from "./project-api-state";

export type { CreateProjectApiDependencies } from "./project-api-shared";

export function createProjectApi(deps: CreateProjectApiDependencies): RuntimeTrpcContext["projectApi"] {
	const ctx = createProjectApiContext(deps);

	return {
		...createGitOps(ctx),
		...createConflictOps(ctx),
		...createStagingOps(ctx),
		...createChangesOps(ctx),
		...createStateOps(ctx),
	};
}
