import { collectTextBlocks, isJsonObject, readBoolean, readString } from "./provider-record-utils.js";
import type { ParsedProviderRecord } from "./types.js";

const CLAUDE_BOUNDARIES = new Map<string, "started" | "resumed" | "restarted" | "compacted">([
	["session_start", "started"],
	["session_resume", "resumed"],
	["session_restart", "restarted"],
	["compact_boundary", "compacted"],
]);

// Claude Code's installed SDK deliberately treats this provider-generated text
// as an interruption marker rather than a user prompt. Keep this exact enough
// that ordinary user text continues through the message path.
const CLAUDE_INTERRUPT_SENTINEL = /^\[Request interrupted by user\]\s*$/;

function createLineage(value: Record<string, unknown>, nativeId: string | null) {
	return nativeId
		? {
				nativeId,
				parentNativeId: readString(value, "parentUuid"),
				parentFieldPresent: Object.hasOwn(value, "parentUuid"),
				isSidechain: readBoolean(value, "isSidechain") === true,
			}
		: undefined;
}

function parsed(
	value: Record<string, unknown>,
	recognized: boolean,
	providerSessionId: string | null,
	item: ParsedProviderRecord["item"],
): ParsedProviderRecord {
	const lineage = createLineage(value, readString(value, "uuid"));
	return { recognized, providerSessionId, item, ...(lineage ? { lineage } : {}) };
}

function readInterruptSentinelContentIndex(content: unknown): number | null {
	if (!Array.isArray(content) || content.length !== 1) {
		return null;
	}
	const block = content[0];
	if (!isJsonObject(block) || readString(block, "type") !== "text") {
		return null;
	}
	const text = readString(block, "text");
	return text && CLAUDE_INTERRUPT_SENTINEL.test(text) ? 0 : null;
}

export function parseClaudeHistoryRecord(value: unknown): ParsedProviderRecord {
	if (!isJsonObject(value)) {
		return { recognized: false, providerSessionId: null, item: { kind: "ignore" } };
	}
	const type = readString(value, "type");
	const providerSessionId = readString(value, "sessionId");
	const nativeId = readString(value, "uuid");

	if (type === "compact_boundary") {
		return parsed(value, true, providerSessionId, {
			kind: "boundary",
			boundary: "compacted",
			nativeId,
			contentIndex: 0,
			stopsOlderScan: true,
		});
	}
	if (type === "system") {
		const subtype = readString(value, "subtype");
		const boundary = subtype ? CLAUDE_BOUNDARIES.get(subtype) : null;
		if (boundary) {
			return parsed(value, true, providerSessionId, {
				kind: "boundary",
				boundary,
				nativeId,
				contentIndex: 0,
				stopsOlderScan: boundary === "compacted",
			});
		}
		return parsed(value, true, providerSessionId, { kind: "ignore" });
	}
	if (type !== "user" && type !== "assistant") {
		return parsed(value, false, providerSessionId, { kind: "ignore" });
	}
	if (readBoolean(value, "isSidechain") === true || readBoolean(value, "isMeta") === true) {
		return parsed(value, true, providerSessionId, { kind: "ignore" });
	}
	if (readBoolean(value, "isCompactSummary") === true) {
		return parsed(value, true, providerSessionId, {
			kind: "boundary",
			boundary: "compacted",
			nativeId,
			contentIndex: 0,
			stopsOlderScan: true,
		});
	}

	const message = value.message;
	if (!isJsonObject(message) || readString(message, "role") !== type) {
		return parsed(value, true, providerSessionId, { kind: "malformed" });
	}
	const interruptContentIndex = type === "user" ? readInterruptSentinelContentIndex(message.content) : null;
	if (interruptContentIndex !== null) {
		return parsed(value, true, providerSessionId, {
			kind: "boundary",
			boundary: "interrupted",
			nativeId,
			contentIndex: interruptContentIndex,
			stopsOlderScan: false,
		});
	}
	const text = collectTextBlocks({ content: message.content, acceptedBlockType: "text" });
	if (!text) {
		return parsed(value, true, providerSessionId, { kind: "ignore" });
	}
	return parsed(value, true, providerSessionId, {
		kind: "message",
		role: type,
		text: text.text,
		nativeId,
		contentIndex: text.firstContentIndex,
	});
}
