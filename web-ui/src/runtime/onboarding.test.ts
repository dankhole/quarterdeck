import { describe, expect, it } from "vitest";

import { isSelectedAgentAuthenticated, shouldShowStartupOnboardingDialog } from "@/runtime/onboarding";

describe("runtime onboarding helpers", () => {
	it("treats non-cline selections as authenticated", () => {
		expect(isSelectedAgentAuthenticated("claude")).toBe(true);
		expect(isSelectedAgentAuthenticated("codex")).toBe(true);
	});

	it("treats cline selection as authenticated", () => {
		expect(isSelectedAgentAuthenticated("cline")).toBe(true);
	});

	it("shows startup onboarding at least once for configured users", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: false,
				isTaskAgentReady: true,
				isSelectedAgentAuthenticated: true,
			}),
		).toBe(true);
	});

	it("does not reopen when onboarding was already shown and readiness is still unknown", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
				isTaskAgentReady: null,
				isSelectedAgentAuthenticated: true,
			}),
		).toBe(false);
	});

	it("shows startup onboarding when selected agent is not authenticated", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
				isTaskAgentReady: true,
				isSelectedAgentAuthenticated: false,
			}),
		).toBe(true);
	});

	it("does not show startup onboarding once shown and setup is ready", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
				isTaskAgentReady: true,
				isSelectedAgentAuthenticated: true,
			}),
		).toBe(false);
	});
});
