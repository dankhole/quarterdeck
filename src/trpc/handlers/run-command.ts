import { TRPCError } from "@trpc/server";
import type { RuntimeCommandRunResponse } from "../../core/api-contract";
import { parseCommandRunRequest } from "../../core/api-validation";
import type { RuntimeTrpcWorkspaceScope } from "../app-router-context";

export interface RunCommandDeps {
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
}

export async function handleRunCommand(
	workspaceScope: RuntimeTrpcWorkspaceScope,
	input: unknown,
	deps: RunCommandDeps,
) {
	try {
		const body = parseCommandRunRequest(input);
		return await deps.runCommand(body.command, workspaceScope.workspacePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message,
		});
	}
}
