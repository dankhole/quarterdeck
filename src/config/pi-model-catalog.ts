import { type ExecFileException, execFile } from "node:child_process";

import type { RuntimePiModelsResponse } from "../core/api/pi-models.js";
import { runtimePiModelsResponseSchema } from "../core/api/pi-models.js";
import { armChildProcessTimeout, type ChildProcessTimeoutGuard } from "../core/process-termination.js";
import { assertRuntimeProcessLaunchAdmission } from "../core/runtime-process-launch-admission.js";
import { resolveWindowsCompatibleCommand } from "../core/windows-cmd-launch.js";
import { resolveAgentCommandForLaunch } from "./agent-registry.js";
import { preparePiModelDiscovery } from "./pi-model-discovery.js";
import type { RuntimeConfigState } from "./runtime-config-normalizers.js";

/** Validate the isolated discovery response; never forward native model objects or raw errors. */
export function parsePiModelCatalog(stdout: string): RuntimePiModelsResponse {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new Error("Pi model catalog format is unavailable.");
	}
	const parsed = runtimePiModelsResponseSchema.safeParse(value);
	if (!parsed.success) throw new Error("Pi model catalog format is unavailable.");
	const seen = new Set<string>();
	return {
		models: parsed.data.models.filter((model) => {
			const key = JSON.stringify(model);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	};
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
	// --list-models ignores enabledModels. Use this installation's native settings and scope resolver instead.
	const discovery = await preparePiModelDiscovery(command.binary, cwd);
	const stdout = await readPiModelCatalog(discovery.binary, discovery.args, cwd);
	return parsePiModelCatalog(stdout);
}
