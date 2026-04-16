import { describe, expect, it } from "vitest";
import type { SettingsFormValues } from "./settings-form";
import { areFormValuesEqual, resolveInitialValues } from "./settings-form";

// ---------------------------------------------------------------------------
// resolveInitialValues
// ---------------------------------------------------------------------------

describe("resolveInitialValues", () => {
	it("uses fallback agent ID when config is null", () => {
		const values = resolveInitialValues(null, "claude");
		expect(values.selectedAgentId).toBe("claude");
	});

	it("uses config agent ID when config is provided", () => {
		const config = { selectedAgentId: "codex" } as Parameters<typeof resolveInitialValues>[0];
		const values = resolveInitialValues(config, "claude");
		expect(values.selectedAgentId).toBe("codex");
	});

	it("returns an object with all expected keys", () => {
		const values = resolveInitialValues(null, "claude");
		expect(values).toHaveProperty("selectedAgentId");
		expect(values).toHaveProperty("showSummaryOnCards");
		expect(values).toHaveProperty("audibleNotificationEvents");
		expect(values).toHaveProperty("shortcuts");
		expect(values).toHaveProperty("worktreeSystemPromptTemplate");
	});
});

// ---------------------------------------------------------------------------
// areFormValuesEqual
// ---------------------------------------------------------------------------

describe("areFormValuesEqual", () => {
	function makeValues(overrides: Partial<SettingsFormValues> = {}): SettingsFormValues {
		return resolveInitialValues(null, "claude") as SettingsFormValues & typeof overrides;
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
