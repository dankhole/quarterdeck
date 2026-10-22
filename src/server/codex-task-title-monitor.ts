import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { readCodexThreadNames } from "../title/codex-thread-names";
import {
	createNativeTaskTitleMonitor,
	type NativeTaskTitleMonitor,
	type NativeTaskTitleMonitorDependencies,
} from "./native-task-title-monitor";

export interface CodexTaskTitleMonitorDependencies extends NativeTaskTitleMonitorDependencies {
	readThreadNames?: typeof readCodexThreadNames;
}

/** Follows native Codex thread names from the launch profile's session_index.jsonl. */
export function createCodexTaskTitleMonitor(deps: CodexTaskTitleMonitorDependencies): NativeTaskTitleMonitor {
	const readThreadNames = deps.readThreadNames ?? readCodexThreadNames;
	return createNativeTaskTitleMonitor(deps, {
		agentId: "codex",
		logTag: "codex-task-title",
		resolveProfileKey: ({ launchPath, profile }) =>
			resolve(launchPath, profile.CODEX_HOME?.trim() || join(profile.HOME || homedir(), ".codex")),
		readTitles: (codexHome, targets) =>
			readThreadNames(codexHome, new Set(targets.map((target) => target.providerSessionId))),
	});
}
