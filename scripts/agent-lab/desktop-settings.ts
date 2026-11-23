import type { Locator, Page } from "playwright-core";

/** The toolbar can be mounted while a modal hides it from accessibility queries. */
export function desktopSettingsButton(page: Page): Locator {
	return page.getByTestId("open-settings-button");
}

function desktopOnboarding(page: Page): Locator {
	return page.getByRole("dialog", { name: "Get started", exact: true });
}

async function closeOnboarding(onboarding: Locator): Promise<void> {
	await onboarding.getByRole("button", { name: "Close dialog", exact: true }).click();
	await onboarding.waitFor({ state: "hidden" });
}

export async function dismissDesktopOnboarding(page: Page): Promise<void> {
	const onboarding = desktopOnboarding(page);
	if (await onboarding.isVisible()) await closeOnboarding(onboarding);
}

/** Open Settings normally, allowing late startup onboarding to close without dismissing other dialogs. */
export async function openDesktopSettings(page: Page): Promise<Locator> {
	const onboarding = desktopOnboarding(page);
	await page.addLocatorHandler(onboarding, closeOnboarding);
	try {
		await desktopSettingsButton(page).click();
		const settings = page.getByRole("dialog", { name: "Settings", exact: true });
		await settings.waitFor({ state: "visible" });
		return settings;
	} finally {
		await page.removeLocatorHandler(onboarding);
	}
}
