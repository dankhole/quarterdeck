import { ClaudeConversationAdapter } from "./claude-conversation-adapter.js";
import { CodexConversationAdapter } from "./codex-conversation-adapter.js";
import type { ConversationReadLimits } from "./limits.js";
import type { ConversationHistoryRoots } from "./provider-source-locator.js";
import type { ConversationProviderAdapterRegistry } from "./types.js";

export function createConversationProviderAdapters(input: {
	roots: ConversationHistoryRoots;
	limits: Readonly<ConversationReadLimits>;
}): ConversationProviderAdapterRegistry {
	return Object.freeze({
		claude: new ClaudeConversationAdapter(input.roots.claude, input.limits),
		codex: new CodexConversationAdapter(input.roots.codex, input.limits),
	});
}
