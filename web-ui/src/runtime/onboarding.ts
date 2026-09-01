export function shouldShowStartupOnboardingDialog(input: {
	hasShownOnboardingDialog: boolean;
	isTaskAgentReady: boolean | null | undefined;
}): boolean {
	if (!input.hasShownOnboardingDialog) {
		return true;
	}
	if (input.isTaskAgentReady === null || input.isTaskAgentReady === undefined) {
		return false;
	}
	return input.isTaskAgentReady === false;
}
