import { describe, expect, it } from "vitest";

import { runtimeShutdownOutcomeSchema } from "../../../src/core/api/runtime-shutdown";

describe("runtime shutdown outcome contract", () => {
	it("round-trips clean and incomplete reports without process-local promises", () => {
		for (const outcome of [
			{ status: "clean", safeToExit: true, safeToReleaseOwnership: true },
			{
				status: "incomplete",
				safeToExit: false,
				safeToReleaseOwnership: false,
				reasons: ["deadline", "persistence_failed"],
			},
		]) {
			expect(runtimeShutdownOutcomeSchema.parse(JSON.parse(JSON.stringify(outcome)))).toEqual(outcome);
		}
	});

	it("rejects incomplete reports that claim release or exit permission", () => {
		for (const permission of ["safeToExit", "safeToReleaseOwnership"]) {
			expect(
				runtimeShutdownOutcomeSchema.safeParse({
					status: "incomplete",
					safeToExit: false,
					safeToReleaseOwnership: false,
					reasons: ["deadline"],
					[permission]: true,
				}).success,
			).toBe(false);
		}
	});

	it("rejects missing reasons, unknown reasons, and extra completion fields", () => {
		const incomplete = {
			status: "incomplete",
			safeToExit: false,
			safeToReleaseOwnership: false,
			reasons: ["deadline"],
		};
		expect(runtimeShutdownOutcomeSchema.safeParse({ ...incomplete, reasons: [] }).success).toBe(false);
		expect(runtimeShutdownOutcomeSchema.safeParse({ ...incomplete, reasons: ["unknown"] }).success).toBe(false);
		expect(runtimeShutdownOutcomeSchema.safeParse({ ...incomplete, completion: Promise.resolve() }).success).toBe(
			false,
		);
	});
});
