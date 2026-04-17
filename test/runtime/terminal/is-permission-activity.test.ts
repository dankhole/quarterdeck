import { describe, expect, it } from "vitest";

import type { RuntimeTaskHookActivity } from "../../../src/core";
import { isPermissionActivity } from "../../../src/terminal";

function nullFilledActivity(partial: Partial<RuntimeTaskHookActivity>): RuntimeTaskHookActivity {
	return {
		hookEventName: partial.hookEventName ?? null,
		notificationType: partial.notificationType ?? null,
		activityText: partial.activityText ?? null,
		toolName: partial.toolName ?? null,
		toolInputSummary: partial.toolInputSummary ?? null,
		finalMessage: partial.finalMessage ?? null,
		source: partial.source ?? null,
		conversationSummaryText: partial.conversationSummaryText ?? null,
	};
}

describe("isPermissionActivity with null-filled partial metadata", () => {
	it("detects PermissionRequest from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ hookEventName: "PermissionRequest" }))).toBe(true);
	});

	it("detects permission_prompt from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ notificationType: "permission_prompt" }))).toBe(true);
	});

	it("detects permission.asked from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ notificationType: "permission.asked" }))).toBe(true);
	});

	it("detects 'Waiting for approval' activityText from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ activityText: "Waiting for approval" }))).toBe(true);
	});

	it("returns false for Stop from partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({ hookEventName: "Stop" }))).toBe(false);
	});

	it("returns false for all-null partial metadata", () => {
		expect(isPermissionActivity(nullFilledActivity({}))).toBe(false);
	});
});
