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
		expect(values).toHaveProperty("showSummaryOnHover");
		expect(values).toHaveProperty("llmSummaryPolishEnabled");
		expect(values).toHaveProperty("audibleNotificationEvents");
		expect(values).toHaveProperty("shortcuts");
		expect(values.worktreeSetupScript).toBe("");
		expect(values).toHaveProperty("worktreeSystemPromptTemplate");
		expect(values).toHaveProperty("fileEditorAutosaveMode");
		expect(values.claudeLaunchPermissionMode).toBe("inherit");
		expect(values.statuslineEnabled).toBe(false);
		expect(values.codexApprovalsReviewer).toBe("inherit");
		expect(values.piToolApprovalsEnabled).toBe(true);
		expect(values.codeNavigationEnabled).toBe(false);
		expect(values.lspServers[0]?.command).toBe("typescript-language-server");
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
		const b = { ...makeValues(), showSummaryOnHover: !a.showSummaryOnHover };
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

	it("compares language server settings structurally and detects nested changes", () => {
		const a = makeValues();
		const b = makeValues({ lspServers: structuredClone(a.lspServers) });
		expect(areFormValuesEqual(a, b)).toBe(true);
		b.lspServers[0]!.args.push("--extra");
		expect(areFormValuesEqual(a, b)).toBe(false);
	});
});
