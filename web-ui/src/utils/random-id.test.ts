import { describe, expect, it } from "vitest";
import { createRandomId } from "./random-id";

describe("createRandomId", () => {
	it("prefixes the generated id", () => {
		expect(createRandomId("browser")).toMatch(/^browser:/);
		expect(createRandomId("lifecycle:start")).toMatch(/^lifecycle:start:/);
	});

	it("generates distinct ids across calls", () => {
		const ids = new Set(Array.from({ length: 50 }, () => createRandomId("id")));
		expect(ids.size).toBe(50);
	});
});
