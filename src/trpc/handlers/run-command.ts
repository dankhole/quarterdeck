import { TRPCError } from "@trpc/server";
import type { RuntimeCommandRunResponse } from "../../core";
import { parseCommandRunRequest } from "../../core";
import type { RuntimeTrpcProjectScope } from "../app-router-context";

export interface RunCommandDeps {
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
}

export async function handleRunCommand(projectScope: RuntimeTrpcProjectScope, input: unknown, deps: RunCommandDeps) {
	try {
		const body = parseCommandRunRequest(input);
		return await deps.runCommand(body.command, projectScope.projectPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message,
		});
	}
}
