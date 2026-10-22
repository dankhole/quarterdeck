import { resolveClaudeTaskProfileRoot } from "../conversation/claude-conversation-export";
import type { ConversationSourceHintReader } from "../conversation/types";
import { ClaudeCustomTitleFollower } from "../title/claude-custom-titles";
import {
	createNativeTaskTitleMonitor,
	type NativeTaskTitleMonitor,
	type NativeTaskTitleMonitorDependencies,
} from "./native-task-title-monitor";

export interface ClaudeTaskTitleMonitorDependencies extends NativeTaskTitleMonitorDependencies {
	hints?: ConversationSourceHintReader;
	readCustomTitles?: ClaudeCustomTitleFollower["read"];
}

/**
 * Follows Claude `/rename` titles from each live session's exact transcript
 * under the launch profile. The generated initial title stays until an
 * explicit custom title appears.
 */
export function createClaudeTaskTitleMonitor(deps: ClaudeTaskTitleMonitorDependencies): NativeTaskTitleMonitor {
	const follower = new ClaudeCustomTitleFollower();
	const read: ClaudeCustomTitleFollower["read"] =
		deps.readCustomTitles ?? ((profileRoot, targets) => follower.read(profileRoot, targets));
	return createNativeTaskTitleMonitor(deps, {
		agentId: "claude",
		logTag: "claude-task-title",
		resolveProfileKey: ({ launchPath, profile }) => resolveClaudeTaskProfileRoot(launchPath, profile),
		readTitles: (profileRoot, targets) =>
			read(
				profileRoot,
				targets.map((target) => ({
					sessionId: target.providerSessionId,
					hint: deps.hints?.getHint(target.projectId, target.taskId, target.providerSessionId) ?? null,
				})),
			),
	});
}
