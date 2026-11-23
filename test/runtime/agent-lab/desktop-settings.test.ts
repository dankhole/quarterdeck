import type { Locator, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { dismissDesktopOnboarding, openDesktopSettings } from "../../../scripts/agent-lab/desktop-settings";

function fixture(onboardingVisible = false) {
	let handler: ((locator: Locator) => Promise<void>) | undefined;
	const events: string[] = [];
	const close = vi.fn(async () => {
		onboardingVisible = false;
		events.push("onboarding closed");
	});
	const onboarding = {
		isVisible: async () => onboardingVisible,
		getByRole: vi.fn(() => ({ click: close })),
		waitFor: vi.fn(async () => {}),
	};
	const settings = {
		waitFor: vi.fn(async () => {
			events.push("settings dialog visible");
		}),
	};
	const button = {
		click: vi.fn(async () => {
			if (handler) await handler(onboarding as unknown as Locator);
			events.push("settings clicked");
		}),
	};
	const page = {
		getByTestId: vi.fn(() => button),
		getByRole: vi.fn((_role: string, { name }: { name: string }) => (name === "Get started" ? onboarding : settings)),
		addLocatorHandler: vi.fn(async (_locator: Locator, callback: typeof handler) => {
			handler = callback;
		}),
		removeLocatorHandler: vi.fn(async () => {
			handler = undefined;
		}),
	};
	return { page: page as unknown as Page, calls: page, onboarding, button, settings, close, events };
}

describe("packaged Settings navigation", () => {
	it("finds the mounted toolbar by its test ID and handles onboarding that appears during the click", async () => {
		const f = fixture();
		await expect(openDesktopSettings(f.page)).resolves.toBe(f.settings);
		expect(f.calls.getByTestId).toHaveBeenCalledExactlyOnceWith("open-settings-button");
		expect(f.calls.getByRole.mock.calls).toEqual([
			["dialog", { name: "Get started", exact: true }],
			["dialog", { name: "Settings", exact: true }],
		]);
		expect(f.onboarding.getByRole).toHaveBeenCalledExactlyOnceWith("button", { name: "Close dialog", exact: true });
		expect(f.events).toEqual(["onboarding closed", "settings clicked", "settings dialog visible"]);
		expect(f.button.click).toHaveBeenCalledExactlyOnceWith(); // No forced click behind a modal.
		expect(f.settings.waitFor).toHaveBeenCalledExactlyOnceWith({ state: "visible" });
		expect(f.calls.removeLocatorHandler).toHaveBeenCalledExactlyOnceWith(f.onboarding);
	});

	it("leaves other modal blockers to normal click actionability and unregisters the handler on failure", async () => {
		const f = fixture();
		f.button.click.mockRejectedValueOnce(new Error("Unsaved files intercepts pointer events"));
		await expect(openDesktopSettings(f.page)).rejects.toThrow("Unsaved files intercepts pointer events");
		expect(f.close).not.toHaveBeenCalled();
		expect(f.settings.waitFor).not.toHaveBeenCalled();
		expect(f.calls.removeLocatorHandler).toHaveBeenCalledExactlyOnceWith(f.onboarding);
	});

	it("dismisses visible startup onboarding through its own close button", async () => {
		const f = fixture(true);
		await dismissDesktopOnboarding(f.page);
		await dismissDesktopOnboarding(f.page);
		expect(f.close).toHaveBeenCalledTimes(1);
		expect(f.onboarding.waitFor).toHaveBeenCalledExactlyOnceWith({ state: "hidden" });
	});
});
