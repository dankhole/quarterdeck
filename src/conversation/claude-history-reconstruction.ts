import type { ParsedProviderRecordAtOffset, ProviderHistoryReconstructionResult } from "./types.js";

export function reconstructClaudeHistory(
	records: readonly ParsedProviderRecordAtOffset[],
): ProviderHistoryReconstructionResult {
	let leaf: ParsedProviderRecordAtOffset | null = null;
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const candidate = records[index];
		if (candidate?.record.lineage && !candidate.record.lineage.isSidechain) {
			leaf = candidate;
			break;
		}
	}
	if (!leaf?.record.lineage?.parentFieldPresent) {
		return { records, incomplete: false, incompleteReason: null };
	}

	const byNativeId = new Map<string, ParsedProviderRecordAtOffset>();
	for (const candidate of records) {
		const nativeId = candidate.record.lineage?.nativeId;
		if (nativeId) {
			byNativeId.set(nativeId, candidate);
		}
	}

	const selected = new Set<ParsedProviderRecordAtOffset>();
	const visited = new Set<string>();
	let cursor: string | null = leaf.record.lineage.nativeId;
	let incomplete = false;
	let incompleteReason: ProviderHistoryReconstructionResult["incompleteReason"] = null;
	while (cursor) {
		if (visited.has(cursor)) {
			incomplete = true;
			incompleteReason = "cycle";
			break;
		}
		visited.add(cursor);
		const candidate = byNativeId.get(cursor);
		if (!candidate?.record.lineage) {
			incomplete = true;
			incompleteReason = "missing_ancestor";
			break;
		}
		selected.add(candidate);
		cursor =
			candidate.record.item.kind === "boundary" && candidate.record.item.stopsOlderScan
				? null
				: candidate.record.lineage.parentNativeId;
	}

	return {
		records: records.filter((candidate) => selected.has(candidate)),
		incomplete,
		incompleteReason,
	};
}
