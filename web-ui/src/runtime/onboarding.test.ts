import { describe, expect, it } from "vitest";

import { shouldShowStartupOnboardingDialog } from "@/runtime/onboarding";

describe("runtime onboarding helpers", () => {
	it("shows startup onboarding at least once for configured users", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: false,
				isTaskAgentReady: true,
			}),
		).toBe(true);
	});

	it("does not reopen when onboarding was already shown and readiness is still unknown", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
				isTaskAgentReady: null,
			}),
		).toBe(false);
	});

	it("shows startup onboarding when no supported agent CLI is ready", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
				isTaskAgentReady: false,
			}),
		).toBe(true);
	});

	it("does not show startup onboarding once shown and setup is ready", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
				isTaskAgentReady: true,
			}),
		).toBe(false);
	});
});
