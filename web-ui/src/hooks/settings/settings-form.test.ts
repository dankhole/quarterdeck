import { describe, expect, it } from "vitest";
import type { SettingsFormValues } from "./settings-form";
import { areFormValuesEqual, resolveInitialValues } from "./settings-form";

// ---------------------------------------------------------------------------
// resolveInitialValues
// ---------------------------------------------------------------------------

describe("resolveInitialValues", () => {
	it("returns an object with all expected keys", () => {
		const values = resolveInitialValues(null);
		expect(values).toHaveProperty("showSummaryOnCards");
		expect(values).toHaveProperty("llmSummaryPolishEnabled");
		expect(values).toHaveProperty("audibleNotificationEvents");
		expect(values).toHaveProperty("shortcuts");
		expect(values).toHaveProperty("worktreeSystemPromptTemplate");
		expect(values).toHaveProperty("fileEditorAutosaveMode");
	});
});

// ---------------------------------------------------------------------------
// areFormValuesEqual
// ---------------------------------------------------------------------------

describe("areFormValuesEqual", () => {
	function makeValues(overrides: Partial<SettingsFormValues> = {}): SettingsFormValues {
		return { ...resolveInitialValues(null), ...overrides };
	}

	it("returns true for identical values", () => {
		const a = makeValues();
		const b = makeValues();
		expect(areFormValuesEqual(a, b)).toBe(true);
	});

	it("detects primitive field changes", () => {
		const a = makeValues();
		const b = { ...makeValues(), showSummaryOnCards: !a.showSummaryOnCards };
		expect(areFormValuesEqual(a, b)).toBe(false);
	});

	it("detects nested audibleNotificationEvents changes", () => {
		const a = makeValues();
		const b = makeValues();
		b.audibleNotificationEvents = {
			...b.audibleNotificationEvents,
			permission: !a.audibleNotificationEvents.permission,
		};
		expect(areFormValuesEqual(a, b)).toBe(false);
	});

	it("detects nested audibleNotificationSuppressCurrentProject changes", () => {
		const a = makeValues();
		const b = makeValues();
		b.audibleNotificationSuppressCurrentProject = {
			...b.audibleNotificationSuppressCurrentProject,
			review: !a.audibleNotificationSuppressCurrentProject.review,
		};
		expect(areFormValuesEqual(a, b)).toBe(false);
	});

	it("detects shortcuts array changes", () => {
		const a = makeValues();
		const b = makeValues();
		b.shortcuts = [{ label: "test", command: "echo hello" }];
		expect(areFormValuesEqual(a, b)).toBe(false);
	});
});
