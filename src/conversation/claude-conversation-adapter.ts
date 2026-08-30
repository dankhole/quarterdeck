import { parseClaudeHistoryRecord } from "./claude-history-parser.js";
import { reconstructClaudeHistory } from "./claude-history-reconstruction.js";
import type { ConversationReadLimits } from "./limits.js";
import { ProviderConversationSourceLocator } from "./provider-source-locator.js";
import { readProviderConversationTail } from "./provider-tail-reader.js";
import type {
	ConversationProviderAdapter,
	ConversationReadRecentInput,
	ConversationSourceLocatorInput,
	ConversationSourceLookup,
} from "./types.js";

export class ClaudeConversationAdapter implements ConversationProviderAdapter {
	readonly providerId = "claude" as const;
	private readonly locator: ProviderConversationSourceLocator;

	constructor(
		roots: readonly string[],
		private readonly limits: Readonly<ConversationReadLimits>,
	) {
		this.locator = new ProviderConversationSourceLocator(this.providerId, roots, limits);
	}

	async locateSource(input: ConversationSourceLocatorInput): Promise<ConversationSourceLookup> {
		return await this.locator.locate(input);
	}

	async readRecent(input: ConversationReadRecentInput) {
		return await readProviderConversationTail({
			read: input,
			limits: this.limits,
			parseRecord: parseClaudeHistoryRecord,
			reconstructRecords: reconstructClaudeHistory,
			requireMessageSessionIdentity: true,
		});
	}
}
