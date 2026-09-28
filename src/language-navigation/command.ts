import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { resolveWindowsBinaryPath } from "../core/command-discovery";
import { mergeProcessEnvironment } from "../core/process-environment";

export async function resolveLanguageServerCommand(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
	if (process.platform === "win32") {
		const found = resolveWindowsBinaryPath(command, env);
		// Batch/PowerShell wrappers require a shell. Use node.exe with the server's JS entry point instead.
		if (!found || ![".exe", ".com"].includes(found.extension)) return null;
		try {
			return (await stat(found.path)).isFile() ? found.path : null;
		} catch {
			return null;
		}
	}
	if ((command.includes("/") || command.includes("\\")) && !isAbsolute(command)) return null;
	const candidates = isAbsolute(command)
		? [command]
		: (env.PATH ?? "")
				.split(delimiter)
				.filter(isAbsolute)
				.map((entry) => resolve(entry, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			if ((await stat(candidate)).isFile()) return candidate;
		} catch {
			/* Keep searching the inherited absolute PATH entries. */
		}
	}
	return null;
}

export async function checkLanguageServerCommand(
	command: string,
	env: Record<string, string> = {},
): Promise<{ available: boolean; message: string }> {
	const available = (await resolveLanguageServerCommand(command, mergeProcessEnvironment(process.env, env))) !== null;
	return {
		available,
		message: available
			? `Found ${command}.`
			: `Cannot directly execute ${command}. Use an executable on PATH or an absolute executable path${process.platform === "win32" ? "; for npm servers use node.exe and the server's JavaScript entry point as an argument" : ""}.`,
	};
}
