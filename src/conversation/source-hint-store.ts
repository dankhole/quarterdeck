import type { RuntimeHookMetadata } from "../core/index.js";
import type { ConversationSourceHint, ConversationSourceHintReader } from "./types.js";

const MAX_SOURCE_HINTS = 1_024;
const MAX_SOURCE_HINT_PATH_LENGTH = 4_096;

interface StoredConversationSourceHint extends ConversationSourceHint {
	projectId: string;
	taskId: string;
}

export interface ConversationSourceHintRecorder {
	recordClaudeHookHint(input: {
		projectId: string;
		taskId: string;
		expectedProviderSessionId: string | null;
		metadata: RuntimeHookMetadata | undefined;
	}): void;
}

function hintKey(projectId: string, taskId: string): string {
	return `${projectId}\0${taskId}`;
}

function isClaudeMetadata(metadata: RuntimeHookMetadata): boolean {
	return metadata.source?.trim().toLowerCase() === "claude";
}

export class ConversationSourceHintStore implements ConversationSourceHintReader, ConversationSourceHintRecorder {
	private readonly hints = new Map<string, StoredConversationSourceHint>();

	recordClaudeHookHint(input: {
		projectId: string;
		taskId: string;
		expectedProviderSessionId: string | null;
		metadata: RuntimeHookMetadata | undefined;
	}): void {
		const metadata = input.metadata;
		const sourcePath = metadata?.transcriptPath?.trim() ?? "";
		const providerSessionId = metadata?.sessionId?.trim() || input.expectedProviderSessionId?.trim() || "";
		if (
			!metadata ||
			!isClaudeMetadata(metadata) ||
			!sourcePath ||
			sourcePath.length > MAX_SOURCE_HINT_PATH_LENGTH ||
			!providerSessionId
		) {
			return;
		}

		const key = hintKey(input.projectId, input.taskId);
		this.hints.delete(key);
		this.hints.set(key, {
			projectId: input.projectId,
			taskId: input.taskId,
			providerId: "claude",
			providerSessionId,
			sourcePath,
		});
		while (this.hints.size > MAX_SOURCE_HINTS) {
			const oldestKey = this.hints.keys().next().value;
			if (typeof oldestKey !== "string") {
				break;
			}
			this.hints.delete(oldestKey);
		}
	}

	getHint(projectId: string, taskId: string, providerSessionId: string): ConversationSourceHint | null {
		const hint = this.hints.get(hintKey(projectId, taskId));
		if (!hint || hint.providerSessionId !== providerSessionId) {
			return null;
		}
		return {
			providerId: hint.providerId,
			providerSessionId: hint.providerSessionId,
			sourcePath: hint.sourcePath,
		};
	}
}
