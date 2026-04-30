import { describe, expect, it } from "vitest";

import {
	COMMIT_CONTROLS_MAX_HEIGHT,
	COMMIT_CONTROLS_MIN_HEIGHT,
	calculateCommitControlsDragHeight,
	clampCommitControlsHeight,
	getCommitControlsResizeBounds,
} from "@/hooks/git/commit-panel-layout";

describe("commit panel layout", () => {
	it("clamps persisted heights to the supported range", () => {
		expect(clampCommitControlsHeight(80)).toBe(COMMIT_CONTROLS_MIN_HEIGHT);
		expect(clampCommitControlsHeight(240)).toBe(240);
		expect(clampCommitControlsHeight(600)).toBe(COMMIT_CONTROLS_MAX_HEIGHT);
	});

	it("reserves minimum room for the changes list when resizing upward", () => {
		const bounds = getCommitControlsResizeBounds({
			startHeight: 196,
			changesListHeight: 160,
		});

		expect(bounds.maxHeight).toBe(244);
	});

	it("increases height when the divider moves upward and decreases it when moved downward", () => {
		const bounds = { minHeight: 172, maxHeight: 300 };

		expect(
			calculateCommitControlsDragHeight({
				startHeight: 196,
				startPointerY: 200,
				pointerY: 150,
				bounds,
			}),
		).toBe(246);
		expect(
			calculateCommitControlsDragHeight({
				startHeight: 196,
				startPointerY: 200,
				pointerY: 260,
				bounds,
			}),
		).toBe(172);
	});

	it("does not resize past the computed bounds", () => {
		const bounds = { minHeight: 172, maxHeight: 240 };

		expect(
			calculateCommitControlsDragHeight({
				startHeight: 196,
				startPointerY: 200,
				pointerY: 40,
				bounds,
			}),
		).toBe(240);
		expect(
			calculateCommitControlsDragHeight({
				startHeight: 196,
				startPointerY: 200,
				pointerY: 360,
				bounds,
			}),
		).toBe(172);
	});
});
