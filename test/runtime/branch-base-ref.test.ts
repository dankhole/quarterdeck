import { describe, expect, it } from "vitest";

import {
	INTEGRATION_BASE_REF_CANDIDATES,
	isRuntimeTaskBaseRefResolved,
	normalizeRuntimeBaseRef,
	resolveRuntimeTaskBaseRefState,
} from "../../src/core";

describe("branch/base-ref runtime model", () => {
	it("keeps integration branch candidates explicit", () => {
		expect(INTEGRATION_BASE_REF_CANDIDATES).toEqual(["main", "master"]);
	});

	it("normalizes blank refs to the unresolved state", () => {
		expect(normalizeRuntimeBaseRef("  ")).toBeNull();
		expect(resolveRuntimeTaskBaseRefState({ baseRef: "", baseRefPinned: true })).toEqual({
			kind: "unresolved",
			baseRef: null,
			isResolved: false,
			isPinned: false,
			tracksBranchChanges: false,
		});
		expect(isRuntimeTaskBaseRefResolved({ baseRef: "" })).toBe(false);
	});

	it("distinguishes inferred and pinned resolved refs", () => {
		expect(resolveRuntimeTaskBaseRefState({ baseRef: " main " })).toEqual({
			kind: "inferred",
			baseRef: "main",
			isResolved: true,
			isPinned: false,
			tracksBranchChanges: true,
		});
		expect(resolveRuntimeTaskBaseRefState({ baseRef: "release", baseRefPinned: true })).toEqual({
			kind: "pinned",
			baseRef: "release",
			isResolved: true,
			isPinned: true,
			tracksBranchChanges: false,
		});
	});
});
