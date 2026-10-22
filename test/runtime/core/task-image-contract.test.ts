import { describe, expect, it } from "vitest";

import {
	applyProjectBoardCommand,
	areRuntimeTaskImagesEqual,
	QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
	type RuntimeBoardData,
	runtimeBoardDataSchema,
	runtimePersistedBoardDataSchema,
	runtimeTaskImageInputSchema,
} from "../../../src/core";

const inline = { id: "img-1", name: "a.png", mimeType: "image/png", data: Buffer.from("abcd").toString("base64") };
const ref = { id: "img-1", name: "a.png", mimeType: "image/png", sha256: "a".repeat(64), byteLength: 4 };

function boardWithCard(images: unknown[]): unknown {
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-a",
						unstarted: true,
						title: null,
						prompt: "Prompt",
						images,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
		],
	};
}

describe("task image contract", () => {
	it("requires the protocol bump that introduced reference-only board attachments", () => {
		// Browsers older than protocol 7 parse cards with inline `data` only and would
		// drop stored references, so a later edit could erase attachments.
		expect(QUARTERDECK_RUNTIME_PROTOCOL_VERSION).toBeGreaterThanOrEqual(7);
	});

	it("accepts inline uploads in the shared card contract but only references on disk", () => {
		expect(runtimeBoardDataSchema.safeParse(boardWithCard([inline])).success).toBe(true);
		expect(runtimeBoardDataSchema.safeParse(boardWithCard([ref])).success).toBe(true);
		expect(runtimePersistedBoardDataSchema.safeParse(boardWithCard([ref])).success).toBe(true);
		expect(runtimePersistedBoardDataSchema.safeParse(boardWithCard([inline])).success).toBe(false);
		expect(runtimeTaskImageInputSchema.safeParse({ ...ref, sha256: "../board.json" }).success).toBe(false);
	});

	it("reads references with fields from a newer runtime but writes only the known shape", () => {
		const future = { ...ref, thumbnailSha256: "b".repeat(64) };
		const read = runtimeBoardDataSchema.parse(boardWithCard([future]));
		expect(read.columns[0]?.cards[0]?.images).toEqual([ref]);
		expect(runtimePersistedBoardDataSchema.safeParse(boardWithCard([future])).success).toBe(false);
		expect(runtimeTaskImageInputSchema.safeParse(future).success).toBe(false);
	});

	it("treats an attachment carrying both bytes and a hash as an inline upload", () => {
		const parsed = runtimeTaskImageInputSchema.parse({ ...inline, sha256: ref.sha256, byteLength: 4 });
		expect(parsed).toEqual(inline);
	});

	it("matches an optimistic inline upload against its stored reference", () => {
		expect(areRuntimeTaskImagesEqual([inline], [ref])).toBe(true);
		expect(areRuntimeTaskImagesEqual([inline], [{ ...ref, byteLength: 5 }])).toBe(false);
		expect(areRuntimeTaskImagesEqual([ref], [{ ...ref, sha256: "b".repeat(64) }])).toBe(false);
		expect(areRuntimeTaskImagesEqual(undefined, [])).toBe(true);

		// The browser overlay re-applies a pending create after the runtime committed it.
		const committed: RuntimeBoardData = runtimeBoardDataSchema.parse(boardWithCard([ref]));
		const result = applyProjectBoardCommand(committed, {
			kind: "create_task",
			columnId: "review",
			taskId: "task-a",
			prompt: "Prompt",
			images: [inline],
			baseRef: "main",
			createdAt: 1,
		});
		expect(result).toEqual({ board: committed, changed: false });
	});
});
