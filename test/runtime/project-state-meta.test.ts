import { describe, expect, it } from "vitest";

import { MAX_RECENT_BOARD_COMMAND_RECEIPTS, projectStateMetaSchema } from "../../src/state/project-state-index";

function createReceipt(index: number) {
	return {
		commandId: `command-${index}`,
		fingerprint: index.toString(16).padStart(64, "0"),
		revision: index + 1,
		appliedAt: index + 1,
		acceptedChange: true,
	};
}

describe("projectStateMetaSchema board command receipts", () => {
	it("loads legacy metadata with an empty receipt ledger", () => {
		expect(projectStateMetaSchema.parse({ revision: 3, updatedAt: 10 })).toEqual({
			revision: 3,
			updatedAt: 10,
			recentBoardCommands: [],
		});
	});

	it("accepts the bounded ledger and rejects an oversized one", () => {
		const receipts = Array.from({ length: MAX_RECENT_BOARD_COMMAND_RECEIPTS }, (_, index) => createReceipt(index));
		expect(
			projectStateMetaSchema.safeParse({ revision: receipts.length, updatedAt: 10, recentBoardCommands: receipts })
				.success,
		).toBe(true);
		expect(
			projectStateMetaSchema.safeParse({
				revision: receipts.length + 1,
				updatedAt: 10,
				recentBoardCommands: [...receipts, createReceipt(receipts.length)],
			}).success,
		).toBe(false);
	});
});
