// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createTestRuntimeConfigResponse } from "@/test-utils/runtime-config-factory";
import type { SettingsFormValues } from "./settings-form";
import { areFormValuesEqual, reconcileSettingsFormValues, resolveInitialValues } from "./settings-form";

// ---------------------------------------------------------------------------
// resolveInitialValues
// ---------------------------------------------------------------------------

describe("resolveInitialValues", () => {
	it("defaults isolation on for older runtimes and preserves explicit false", () => {
		expect(resolveInitialValues(null).defaultUseWorktree).toBe(true);
		expect(
			resolveInitialValues(createTestRuntimeConfigResponse({ defaultUseWorktree: undefined })).defaultUseWorktree,
		).toBe(true);
		expect(
			resolveInitialValues(createTestRuntimeConfigResponse({ defaultUseWorktree: false })).defaultUseWorktree,
		).toBe(false);
	});
	it("returns an object with all expected keys", () => {
		const values = resolveInitialValues(null);
		expect(values).not.toHaveProperty("showSummaryOnCards");
		expect(values).not.toHaveProperty("showSummaryOnHover");
		expect(values).not.toHaveProperty("llmSummaryPolishEnabled");
		expect(values).toHaveProperty("audibleNotificationEvents");
		expect(values).toHaveProperty("shortcuts");
		expect(values.worktreeSetupScript).toBe("");
		expect(values).toHaveProperty("worktreeSystemPromptTemplate");
		expect(values).toHaveProperty("fileEditorAutosaveMode");
		expect(values.claudeLaunchPermissionMode).toBe("inherit");
		expect(values.codexApprovalsReviewer).toBe("inherit");
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

	it("detects changes to the project isolation default", () => {
		expect(areFormValuesEqual(makeValues(), makeValues({ defaultUseWorktree: false }))).toBe(false);
	});

	it("detects primitive field changes", () => {
		const a = makeValues();
		const b = { ...makeValues(), shellAutoRestartEnabled: !a.shellAutoRestartEnabled };
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

describe("reconcileSettingsFormValues", () => {
	it("keeps edited fields while accepting remote changes to untouched settings", () => {
		const previous = resolveInitialValues(null);
		const draft = { ...previous, terminalFontWeight: 600 };
		const next = { ...previous, terminalFontWeight: 500, audibleNotificationVolume: 0.25 };
		expect(reconcileSettingsFormValues(draft, previous, next)).toMatchObject({
			terminalFontWeight: 600,
			audibleNotificationVolume: 0.25,
		});
	});
});
