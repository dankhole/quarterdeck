import { TRPCError } from "@trpc/server";
import type { IRuntimeHostIntegrations } from "../../core";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export async function handleOpenFile(
	projectScope: RuntimeTrpcProjectScope | null,
	input: { filePath: string },
	deps: { hostIntegrations: Pick<IRuntimeHostIntegrations, "openPath"> },
) {
	const filePath = input.filePath.trim();
	if (!filePath) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "File path cannot be empty.",
		});
	}
	return await deps.hostIntegrations.openPath(filePath, {
		projectId: projectScope?.projectId,
	});
}
