import { createHash } from "node:crypto";
import type { RuntimeProjectBoardCommand } from "../core";

/** Exact pre-migration payload hashes keep interrupted lifecycle steps replayable after upgrading. */
export function getLegacyBacklogCommandFingerprints(commands: readonly RuntimeProjectBoardCommand[]): string[] {
	// Managed lifecycle steps have one command. Do not reinterpret arbitrary client batches.
	if (commands.length !== 1) return [];
	const command = commands[0];
	let legacy: Record<string, unknown>;
	if (command?.kind === "create_task" && command.columnId === "review") {
		legacy = { ...command, columnId: "backlog" };
	} else if (command?.kind === "move_task") {
		legacy = { ...command };
		if (
			command.sourceColumnId === "review" &&
			command.targetColumnId === "in_progress" &&
			command.expectedUnstarted === true
		) {
			legacy.sourceColumnId = "backlog";
			delete legacy.expectedUnstarted;
		} else if (
			command.sourceColumnId === "in_progress" &&
			command.targetColumnId === "review" &&
			command.unstarted === true
		) {
			legacy.targetColumnId = "backlog";
			delete legacy.unstarted;
		} else if (
			command.sourceColumnId === "review" &&
			command.targetColumnId === "trash" &&
			command.expectedUnstarted === undefined &&
			command.unstarted === undefined
		) {
			legacy.sourceColumnId = "backlog";
		} else {
			return [];
		}
	} else {
		return [];
	}
	return [
		createHash("sha256")
			.update(JSON.stringify([legacy]))
			.digest("hex"),
	];
}
