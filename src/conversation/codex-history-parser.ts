import { collectTextBlocks, isJsonObject, readNonNegativeInteger, readString } from "./provider-record-utils.js";
import type { ParsedProviderRecord } from "./types.js";

export type CodexHistoryMode = "legacy" | "paginated" | null;

export type ParsedCodexSessionHeader =
	| { status: "valid"; providerSessionId: string | null; historyMode: CodexHistoryMode; cliVersion: string | null }
	| { status: "invalid" }
	| { status: "unsupported_cli_version" | "unsupported_history_mode" };

interface CodexHistoryParserState {
	newerUserTurnIds: Set<string>;
}

type SemverTuple = readonly [major: number, minor: number, patch: number];

const MINIMUM_CODEX_HISTORY_VERSION: SemverTuple = [0, 142, 5];
const MAXIMUM_CODEX_HISTORY_VERSION: SemverTuple = [0, 149, 1];

function ignored(recognized: boolean, providerSessionId: string | null = null): ParsedProviderRecord {
	return { recognized, providerSessionId, item: { kind: "ignore" } };
}

function isSupportedCodexHistoryMode(value: string): value is Exclude<CodexHistoryMode, null> {
	return value === "legacy" || value === "paginated";
}

function parseSemverTuple(value: string): SemverTuple | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverTuple(left: SemverTuple, right: SemverTuple): number {
	for (let index = 0; index < left.length; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

function isSupportedCodexCliVersion(value: string): boolean {
	const version = parseSemverTuple(value);
	return Boolean(
		version &&
			compareSemverTuple(version, MINIMUM_CODEX_HISTORY_VERSION) >= 0 &&
			compareSemverTuple(version, MAXIMUM_CODEX_HISTORY_VERSION) <= 0,
	);
}

export function parseCodexSessionHeader(value: unknown): ParsedCodexSessionHeader {
	if (!isJsonObject(value) || readString(value, "type") !== "session_meta" || !isJsonObject(value.payload)) {
		return { status: "invalid" };
	}
	const historyModeValue = value.payload.history_mode;
	const cliVersionValue = value.payload.cli_version;
	if (
		(historyModeValue !== undefined && typeof historyModeValue !== "string") ||
		(cliVersionValue !== undefined && typeof cliVersionValue !== "string")
	) {
		return { status: "invalid" };
	}
	if (typeof cliVersionValue === "string" && !isSupportedCodexCliVersion(cliVersionValue)) {
		return { status: "unsupported_cli_version" };
	}
	let historyMode: CodexHistoryMode = null;
	if (typeof historyModeValue === "string") {
		if (!isSupportedCodexHistoryMode(historyModeValue)) {
			return { status: "unsupported_history_mode" };
		}
		historyMode = historyModeValue;
	}
	return {
		status: "valid",
		providerSessionId: readString(value.payload, "id"),
		historyMode,
		cliVersion: cliVersionValue ?? null,
	};
}

function readCodexUserTurnId(payload: Record<string, unknown>): string | null {
	const metadata = payload.internal_chat_message_metadata_passthrough;
	return isJsonObject(metadata) ? readString(metadata, "turn_id") : null;
}

function hasOnlyTextBlockKeys(block: Record<string, unknown>): boolean {
	return Object.keys(block).every((key) => key === "type" || key === "text");
}

function isEnvironmentContextText(value: string | null): boolean {
	return Boolean(value?.startsWith("<environment_context>") && value.trimEnd().endsWith("</environment_context>"));
}

function isInjectedCodexContext(content: unknown): boolean {
	if (!Array.isArray(content)) {
		return false;
	}
	if (content.length === 1) {
		const environmentBlock = content[0];
		return Boolean(
			isJsonObject(environmentBlock) &&
				hasOnlyTextBlockKeys(environmentBlock) &&
				readString(environmentBlock, "type") === "input_text" &&
				isEnvironmentContextText(readString(environmentBlock, "text")),
		);
	}
	if (content.length !== 2) return false;
	const instructionBlock = content[0];
	const environmentBlock = content[1];
	if (
		!isJsonObject(instructionBlock) ||
		!isJsonObject(environmentBlock) ||
		!hasOnlyTextBlockKeys(instructionBlock) ||
		!hasOnlyTextBlockKeys(environmentBlock) ||
		readString(instructionBlock, "type") !== "input_text" ||
		readString(environmentBlock, "type") !== "input_text"
	) {
		return false;
	}
	const instructions = readString(instructionBlock, "text");
	const environment = readString(environmentBlock, "text");
	return Boolean(
		instructions?.startsWith("# AGENTS.md instructions for ") &&
			instructions.includes("<INSTRUCTIONS>") &&
			instructions.trimEnd().endsWith("</INSTRUCTIONS>") &&
			isEnvironmentContextText(environment),
	);
}

function parseCodexHistoryRecord(value: unknown, state: CodexHistoryParserState): ParsedProviderRecord {
	if (!isJsonObject(value)) {
		return ignored(false);
	}
	const type = readString(value, "type");
	const payload = value.payload;
	if (type === "session_meta") {
		const header = parseCodexSessionHeader(value);
		if (header.status !== "valid") {
			return { recognized: true, providerSessionId: null, item: { kind: "malformed" } };
		}
		return {
			recognized: true,
			providerSessionId: header.providerSessionId,
			item: {
				kind: "boundary",
				boundary: "started",
				nativeId: header.providerSessionId,
				contentIndex: 0,
				stopsOlderScan: false,
			},
		};
	}
	if (type === "compacted" || type === "compaction") {
		const nativeId = isJsonObject(payload) ? readString(payload, "id") : null;
		return {
			recognized: true,
			providerSessionId: null,
			item: { kind: "boundary", boundary: "compacted", nativeId, contentIndex: 0, stopsOlderScan: true },
		};
	}
	if (type === "event_msg" && isJsonObject(payload) && readString(payload, "type") === "thread_rolled_back") {
		const numTurns = readNonNegativeInteger(payload, "num_turns");
		return numTurns === null
			? { recognized: true, providerSessionId: null, item: { kind: "malformed" } }
			: { recognized: true, providerSessionId: null, item: { kind: "rollback", numTurns } };
	}
	if (type !== "response_item") {
		return ignored(false);
	}
	if (!isJsonObject(payload) || readString(payload, "type") !== "message") {
		return ignored(true);
	}
	const role = readString(payload, "role");
	if (role !== "user" && role !== "assistant") {
		return ignored(true);
	}
	if (role === "user") {
		const turnId = readCodexUserTurnId(payload);
		const injectedContext = isInjectedCodexContext(payload.content);
		if (injectedContext) {
			return turnId && state.newerUserTurnIds.has(turnId)
				? ignored(true)
				: { recognized: true, providerSessionId: null, item: { kind: "malformed" } };
		}
		if (turnId) {
			if (state.newerUserTurnIds.has(turnId)) {
				return { recognized: true, providerSessionId: null, item: { kind: "malformed" } };
			}
			state.newerUserTurnIds.add(turnId);
		}
	}
	const text = collectTextBlocks({
		content: payload.content,
		acceptedBlockType: role === "user" ? "input_text" : "output_text",
	});
	if (!text) {
		return ignored(true);
	}
	return {
		recognized: true,
		providerSessionId: null,
		item: {
			kind: "message",
			role,
			text: text.text,
			nativeId: readString(payload, "id"),
			contentIndex: text.firstContentIndex,
		},
	};
}

export function createCodexHistoryRecordParser(): (value: unknown) => ParsedProviderRecord {
	const state: CodexHistoryParserState = { newerUserTurnIds: new Set() };
	return (value) => parseCodexHistoryRecord(value, state);
}
