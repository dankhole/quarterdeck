import type { RuntimeHookMetadata } from "../core/index.js";
import type { ConversationSourceHint, ConversationSourceHintReader } from "./types.js";

const MAX_SOURCE_HINTS = 1_024;
const MAX_SOURCE_HINT_PATH_LENGTH = 4_096;

interface StoredConversationSourceHint extends ConversationSourceHint {
	projectId: string;
	taskId: string;
}

export interface ConversationSourceHintRecorder {
	recordProviderHookHint(input: {
		projectId: string;
		taskId: string;
		expectedProviderSessionId: string | null;
		metadata: RuntimeHookMetadata | undefined;
	}): void;
}

function hintKey(projectId: string, taskId: string): string {
	return `${projectId}\0${taskId}`;
}

function hookProvider(metadata: RuntimeHookMetadata) {
	const source = metadata.source?.trim().toLowerCase();
	return source === "claude" || source === "codex" ? source : null;
}

export class ConversationSourceHintStore implements ConversationSourceHintReader, ConversationSourceHintRecorder {
	private readonly hints = new Map<string, StoredConversationSourceHint>();

	recordProviderHookHint(input: {
		projectId: string;
		taskId: string;
		expectedProviderSessionId: string | null;
		metadata: RuntimeHookMetadata | undefined;
	}): void {
		const metadata = input.metadata;
		const providerId = metadata ? hookProvider(metadata) : null;
		const sourcePath = metadata?.transcriptPath?.trim() ?? "";
		const providerSessionId = metadata?.sessionId?.trim() || input.expectedProviderSessionId?.trim() || "";
		if (
			!metadata ||
			!providerId ||
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
			providerId,
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
