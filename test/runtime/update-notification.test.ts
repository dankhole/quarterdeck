import { describe, expect, it, vi } from "vitest";
import { notifyAboutAvailableUpdate } from "../../src/update-notification";

describe("notifyAboutAvailableUpdate", () => {
	it("skips update discovery for non-interactive launches", () => {
		const createNotifier = vi.fn();

		notifyAboutAvailableUpdate({ isInteractive: false, createNotifier });

		expect(createNotifier).not.toHaveBeenCalled();
	});

	it("configures a non-blocking daily latest-version notice", () => {
		const notify = vi.fn();
		const createNotifier = vi.fn(() => ({ notify }));

		notifyAboutAvailableUpdate({ isInteractive: true, createNotifier });

		expect(createNotifier).toHaveBeenCalledWith({
			pkg: { name: "quarterdeck", version: "0.12.4" },
			distTag: "latest",
			updateCheckInterval: 86_400_000,
		});
		expect(notify).toHaveBeenCalledWith({
			defer: false,
			message:
				"Quarterdeck {latestVersion} is available (current: {currentVersion}).\nRun npm install --global quarterdeck@latest to update.",
		});
	});

	it("suppresses notifier failures", () => {
		expect(() =>
			notifyAboutAvailableUpdate({
				isInteractive: true,
				createNotifier: () => {
					throw new Error("registry unavailable");
				},
			}),
		).not.toThrow();
	});
});
