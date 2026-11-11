// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createTestRuntimeConfigResponse } from "@/test-utils/runtime-config-factory";
import type { SettingsFormValues } from "./settings-form";
import {
	buildSettingsSaveRequest,
	getChangedSettingsScopes,
	reconcileSettingsFormValues,
	resolveInitialValues,
} from "./settings-form";

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
	it("defaults generated worktrees off for missing or older config and restores saved values", () => {
		expect(resolveInitialValues(null).showGeneratedWorktrees).toBe(false);
		const olderConfig = createTestRuntimeConfigResponse();
		Reflect.deleteProperty(olderConfig, "showGeneratedWorktrees");
		expect(resolveInitialValues(olderConfig).showGeneratedWorktrees).toBe(false);
		expect(
			resolveInitialValues(createTestRuntimeConfigResponse({ showGeneratedWorktrees: true })).showGeneratedWorktrees,
		).toBe(true);
	});
	it("defaults branch folders off for older runtimes and preserves explicit saved values", () => {
		expect(resolveInitialValues(null).groupBranchesByFolder).toBe(false);
		const olderConfig = createTestRuntimeConfigResponse();
		Reflect.deleteProperty(olderConfig, "groupBranchesByFolder");
		expect(resolveInitialValues(olderConfig).groupBranchesByFolder).toBe(false);
		for (const value of [true, false]) {
			expect(
				resolveInitialValues(createTestRuntimeConfigResponse({ groupBranchesByFolder: value }))
					.groupBranchesByFolder,
			).toBe(value);
		}
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
// getChangedSettingsScopes
// ---------------------------------------------------------------------------

describe("getChangedSettingsScopes", () => {
	function makeValues(overrides: Partial<SettingsFormValues> = {}): SettingsFormValues {
		return { ...resolveInitialValues(null), ...overrides };
	}

	it("reports no changes for identical values", () => {
		const a = makeValues();
		const b = makeValues();
		expect(getChangedSettingsScopes(a, b)).toEqual([]);
	});

	it("detects changes to the project isolation default", () => {
		expect(getChangedSettingsScopes(makeValues(), makeValues({ defaultUseWorktree: false }))).not.toEqual([]);
	});

	it("detects generated worktree preference changes", () => {
		expect(getChangedSettingsScopes(makeValues(), makeValues({ showGeneratedWorktrees: true }))).not.toEqual([]);
	});

	it("tracks branch folders only as a global change and clears dirtiness when reverted", () => {
		const initial = makeValues();
		const grouped = makeValues({ groupBranchesByFolder: true });
		expect(getChangedSettingsScopes(grouped, initial)).toEqual(["global"]);
		expect(buildSettingsSaveRequest(grouped, false).groupBranchesByFolder).toBe(true);
		expect(getChangedSettingsScopes({ ...grouped, groupBranchesByFolder: false }, initial)).toEqual([]);
	});

	it("detects primitive field changes", () => {
		const a = makeValues();
		const b = { ...makeValues(), shellAutoRestartEnabled: !a.shellAutoRestartEnabled };
		expect(getChangedSettingsScopes(a, b)).not.toEqual([]);
	});

	it("detects nested audibleNotificationEvents changes", () => {
		const a = makeValues();
		const b = makeValues();
		b.audibleNotificationEvents = {
			...b.audibleNotificationEvents,
			permission: !a.audibleNotificationEvents.permission,
		};
		expect(getChangedSettingsScopes(a, b)).not.toEqual([]);
	});

	it("detects nested audibleNotificationSuppressCurrentProject changes", () => {
		const a = makeValues();
		const b = makeValues();
		b.audibleNotificationSuppressCurrentProject = {
			...b.audibleNotificationSuppressCurrentProject,
			review: !a.audibleNotificationSuppressCurrentProject.review,
		};
		expect(getChangedSettingsScopes(a, b)).not.toEqual([]);
	});

	it("treats absent and empty shortcut icons as equal, including during reconciliation", () => {
		const initial = makeValues({ shortcuts: [{ label: "Run", command: "npm test" }] });
		const current = makeValues({ shortcuts: [{ label: "Run", command: "npm test", icon: "" }] });
		expect(getChangedSettingsScopes(current, initial)).toEqual([]);
		const next = makeValues({ shortcuts: [{ label: "Updated", command: "npm test" }] });
		expect(reconcileSettingsFormValues(current, initial, next).shortcuts).toEqual(next.shortcuts);
	});

	it("detects shortcuts array changes", () => {
		const a = makeValues();
		const b = makeValues();
		b.shortcuts = [{ label: "test", command: "echo hello" }];
		expect(getChangedSettingsScopes(a, b)).not.toEqual([]);
	});

	it("compares language server settings structurally and detects nested changes", () => {
		const a = makeValues();
		const b = makeValues({ lspServers: structuredClone(a.lspServers) });
		expect(getChangedSettingsScopes(a, b)).toEqual([]);
		b.lspServers[0]!.args.push("--extra");
		expect(getChangedSettingsScopes(a, b)).not.toEqual([]);
	});
});

describe("settings save scopes", () => {
	it("reports global, project, and mixed changes including nested controls", () => {
		const initial = resolveInitialValues(null);
		expect(getChangedSettingsScopes(initial, initial)).toEqual([]);
		expect(getChangedSettingsScopes({ ...initial, defaultUseWorktree: false }, initial)).toEqual(["project"]);
		expect(getChangedSettingsScopes({ ...initial, lspServers: [] }, initial)).toEqual(["global"]);
		expect(
			getChangedSettingsScopes({ ...initial, worktreeSetupScript: "npm ci", terminalFontWeight: 600 }, initial),
		).toEqual(["global", "project"]);
	});

	it("omits project controls without a destination and preserves every field with one", () => {
		const fields = { ...resolveInitialValues(null), worktreeSetupScript: "npm ci", defaultUseWorktree: false };
		const global = buildSettingsSaveRequest(fields, false);
		expect(global).not.toHaveProperty("shortcuts");
		expect(global).not.toHaveProperty("worktreeSetupScript");
		expect(global).not.toHaveProperty("defaultUseWorktree");
		expect(global).toHaveProperty("worktreeSystemPromptTemplate");
		expect(buildSettingsSaveRequest(fields, true)).toBe(fields);
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
