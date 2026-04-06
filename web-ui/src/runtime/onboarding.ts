import type { RuntimeAgentId } from "@/runtime/types";

export function isSelectedAgentAuthenticated(_selectedAgentId: RuntimeAgentId | null | undefined): boolean {
	// All agents are authenticated via their own CLI.
	return true;
}

export function shouldShowStartupOnboardingDialog(input: {
	hasShownOnboardingDialog: boolean;
	isTaskAgentReady: boolean | null | undefined;
	isSelectedAgentAuthenticated: boolean;
}): boolean {
	if (!input.hasShownOnboardingDialog) {
		return true;
	}
	if (input.isTaskAgentReady === null || input.isTaskAgentReady === undefined) {
		return false;
	}
	if (!input.isSelectedAgentAuthenticated) {
		return true;
	}
	return input.isTaskAgentReady === false;
}
