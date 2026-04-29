import { afterEach, describe, expect, it, vi } from "vitest";

import { createUniqueTaskId } from "../../src/core/task-id";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createUniqueTaskId", () => {
	it("uses random entropy in the final fallback", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.123456789);

		const taskId = createUniqueTaskId(new Set(["abcde"]), () => "abcde00000");

		expect(taskId).toBe("44444");
	});

	it("keeps the final fallback fixed-length when random returns zero", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);

		const taskId = createUniqueTaskId(new Set(["abcde"]), () => "abcde00000");

		expect(taskId).toBe("00000");
		expect(taskId).toHaveLength(5);
	});
});
