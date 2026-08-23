import { TRPCError } from "@trpc/server";
import type { IRuntimeHostIntegrations } from "../../core";

export async function handleOpenFile(
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
	return await deps.hostIntegrations.openPath(filePath);
}
