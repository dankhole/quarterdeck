import { describe, expect, it } from "vitest";

import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";

describe("estimateTaskSessionGeometry", () => {
	it("uses a wide bounded viewport estimate and near-full viewport height", () => {
		expect(estimateTaskSessionGeometry(1440, 900)).toEqual({
			cols: 160,
			rows: 53,
		});
	});

	it("enforces minimum terminal dimensions", () => {
		expect(estimateTaskSessionGeometry(100, 100)).toEqual({
			cols: 20,
			rows: 12,
		});
	});
});
