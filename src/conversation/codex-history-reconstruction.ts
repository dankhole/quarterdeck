import type { ParsedProviderRecordAtOffset, ProviderHistoryReconstructionResult } from "./types.js";

export function reconstructCodexHistory(
	records: readonly ParsedProviderRecordAtOffset[],
): ProviderHistoryReconstructionResult {
	const reconstructed: ParsedProviderRecordAtOffset[] = [];
	let incomplete = false;
	let incompleteReason: ProviderHistoryReconstructionResult["incompleteReason"] = null;
	for (const candidate of records) {
		if (candidate.record.item.kind !== "rollback") {
			reconstructed.push(candidate);
			continue;
		}
		for (let remaining = candidate.record.item.numTurns; remaining > 0; remaining -= 1) {
			let userIndex = -1;
			for (let index = reconstructed.length - 1; index >= 0; index -= 1) {
				const item = reconstructed[index]?.record.item;
				if (item?.kind === "message" && item.role === "user") {
					userIndex = index;
					break;
				}
			}
			if (userIndex < 0) {
				incomplete = true;
				incompleteReason = "rollback_underflow";
				break;
			}
			reconstructed.splice(userIndex);
		}
	}
	return { records: reconstructed, incomplete, incompleteReason };
}
