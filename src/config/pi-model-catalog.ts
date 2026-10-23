import { type ExecFileException, execFile } from "node:child_process";

import type { RuntimePiModelsResponse } from "../core/api/pi-models.js";
import { runtimePiModelSchema } from "../core/api/pi-models.js";
import { armChildProcessTimeout, type ChildProcessTimeoutGuard } from "../core/process-termination.js";
import { assertRuntimeProcessLaunchAdmission } from "../core/runtime-process-launch-admission.js";
import { resolveWindowsCompatibleCommand } from "../core/windows-cmd-launch.js";
import { resolveAgentCommandForLaunch } from "./agent-registry.js";
import type { RuntimeConfigState } from "./runtime-config-normalizers.js";

// Pi resolves packages before filtering resources; offline also prevents missing-package installation.
const DISCOVERY_ARGS = [
	"--list-models",
	"--offline",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-mcp",
	"--no-approve",
];

/** Pi 1.4.0's native table contains only available chat models. Never forward raw CLI output. */
export function parsePiModelCatalog(stdout: string): RuntimePiModelsResponse {
	const lines = stdout.trim().split(/\r?\n/);
	if (lines[0]?.startsWith("No models available.")) return { models: [] };
	if (lines.shift()?.trim().split(/\s+/).join(" ") !== "provider model context max-out thinking images") {
		throw new Error("Pi model catalog format is unavailable.");
	}
	const models: RuntimePiModelsResponse["models"] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const fields = line.trim().split(/\s+/);
		if (
			fields.length !== 6 ||
			!/^\d+(?:\.\d+)?[KM]?$/.test(fields[2] ?? "") ||
			!/^\d+(?:\.\d+)?[KM]?$/.test(fields[3] ?? "") ||
			!["yes", "no"].includes(fields[4] ?? "") ||
			!["yes", "no"].includes(fields[5] ?? "")
		) {
			throw new Error("Pi model catalog format is unavailable.");
		}
		const parsed = runtimePiModelSchema.safeParse({ provider: fields[0], id: fields[1] });
		if (!parsed.success) throw new Error("Pi model catalog contains unsupported identifiers.");
		const key = JSON.stringify(parsed.data);
		if (!seen.has(key)) models.push(parsed.data);
		seen.add(key);
	}
	return { models };
}

function readPiModelCatalog(binary: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const command = resolveWindowsCompatibleCommand(binary, args);
		assertRuntimeProcessLaunchAdmission();
		let settled = false;
		let guard: ChildProcessTimeoutGuard | null = null;
		const finish = (error: ExecFileException | null, stdout: string): void => {
			if (settled) return;
			settled = true;
			guard?.settle();
			if (error || guard?.isTimedOut()) {
				// Errors from execFile contain arguments and stderr, potentially including private config values.
				reject(new Error("Pi model discovery failed. You can still use Pi default."));
			} else resolve(stdout);
		};
		const child = execFile(
			command.binary,
			command.args,
			{
				cwd,
				encoding: "utf8",
				windowsHide: true,
				maxBuffer: 1024 * 1024,
				env: { ...process.env, PI_OFFLINE: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
			},
			(error, stdout) => finish(error, stdout),
		);
		child.stdin?.end();
		if (!settled) guard = armChildProcessTimeout(child, 5_000, { onAbandoned: () => finish(null, "") });
	});
}

/** Metadata only: no prompt/session, custom task arguments, executable resources, installs, or model requests. */
export async function loadPiModelCatalog(
	config: RuntimeConfigState,
	cwd: string,
	dependencies: {
		resolveCommand?: typeof resolveAgentCommandForLaunch;
	} = {},
): Promise<RuntimePiModelsResponse> {
	const command = await (dependencies.resolveCommand ?? resolveAgentCommandForLaunch)({
		...config,
		selectedAgentId: "pi",
	});
	// Do not forward configured launch arguments: they may load code or contain prompts/credentials.
	const stdout = await readPiModelCatalog(command.binary, [...DISCOVERY_ARGS], cwd);
	return parsePiModelCatalog(stdout);
}
