import { describe, expect, it, vi } from "vitest";
import { recoverDesktopAfterInstallerFailure } from "../src/installer-recovery.js";

describe("failed native installer recovery", () => {
	it("reopens native Quit and creates a usable stopped surface after Electron destroys every window", async () => {
		const order: string[] = [];
		let quitting = true;
		let windowExists = false;
		await recoverDesktopAfterInstallerFailure({
			releaseFrontendSeal: () => order.push("release"),
			reopenQuitGate: () => {
				quitting = false;
				order.push("reopen");
			},
			hasWindow: () => windowExists,
			createWindow: () => {
				expect(quitting).toBe(false);
				windowExists = true;
				order.push("create");
			},
			showStoppedSurface: async () => {
				expect(windowExists).toBe(true);
				order.push("surface");
			},
			markRuntimeStopped: () => order.push("stopped"),
		});
		expect(order).toEqual(["release", "reopen", "create", "surface", "stopped"]);
	});
	it("preserves a surviving product document for offline draft export without replacing it", async () => {
		const createWindow = vi.fn();
		const showStoppedSurface = vi.fn(async () => undefined);
		await recoverDesktopAfterInstallerFailure({
			releaseFrontendSeal: vi.fn(),
			reopenQuitGate: vi.fn(),
			hasWindow: () => true,
			createWindow,
			showStoppedSurface,
			markRuntimeStopped: vi.fn(),
		});
		expect(createWindow).not.toHaveBeenCalled();
		expect(showStoppedSurface).not.toHaveBeenCalled();
	});
});
