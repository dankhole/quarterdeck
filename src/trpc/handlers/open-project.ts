import { TRPCError } from "@trpc/server";
import type { IRuntimeHostIntegrations } from "../../core";
import { parseOpenProjectRequest } from "../../core";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export async function handleOpenProject(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: { hostIntegrations: Pick<IRuntimeHostIntegrations, "openProject"> },
) {
	try {
		const body = parseOpenProjectRequest(input);
		return await deps.hostIntegrations.openProject(body.targetId, projectScope.projectPath, {
			projectId: projectScope.projectId,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
}
