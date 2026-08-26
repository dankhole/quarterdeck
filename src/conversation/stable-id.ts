import { createHash } from "node:crypto";

import type { ConversationBoundaryKind, ConversationMessageRole } from "./contracts.js";
import type { ConversationProviderId } from "./types.js";

function digest(parts: readonly (number | string)[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(String(part));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function createNativeConversationEntryId(input: {
	providerId: ConversationProviderId;
	sessionId: string;
	nativeId: string;
	kind: ConversationMessageRole | ConversationBoundaryKind;
}): string {
	return `conversation_${digest(["v1", input.providerId, input.sessionId, "native", input.kind, input.nativeId])}`;
}

export function createSourceCoordinateConversationEntryId(input: {
	providerId: ConversationProviderId;
	sessionId: string;
	byteOffset: number;
	contentIndex: number;
	kind: ConversationMessageRole | ConversationBoundaryKind;
}): string {
	return `conversation_${digest([
		"v1",
		input.providerId,
		input.sessionId,
		"source",
		input.byteOffset,
		input.contentIndex,
		input.kind,
	])}`;
}

export function createHistoryGapId(oldestEntryId: string | null, sessionId: string): string {
	return `conversation_${digest(["v1", "history_gap", sessionId, oldestEntryId ?? "empty"])}`;
}
