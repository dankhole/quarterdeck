// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBrowserServiceWorker } from "./service-worker-registration";

afterEach(() => vi.unstubAllGlobals());

describe("browser service-worker registration", () => {
	it.each(["http:", "https:"])("preserves PWA registration on %s", async (protocol) => {
		vi.stubGlobal("window", { location: { protocol } });
		const register = vi.fn(async () => undefined);
		vi.stubGlobal("navigator", { serviceWorker: { register } });
		await registerBrowserServiceWorker();
		expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js");
	});
	it.each(["app:", "file:"])("does not access service workers on %s", async (protocol) => {
		vi.stubGlobal("window", { location: { protocol } });
		const serviceWorker = vi.fn(() => {
			throw new Error("Service workers are unavailable on this origin.");
		});
		vi.stubGlobal("navigator", {
			get serviceWorker() {
				return serviceWorker();
			},
		});
		await registerBrowserServiceWorker();
		expect(serviceWorker).not.toHaveBeenCalled();
	});
	it("keeps startup working in browsers without service-worker support", async () => {
		vi.stubGlobal("window", { location: { protocol: "https:" } });
		vi.stubGlobal("navigator", {});
		await expect(registerBrowserServiceWorker()).resolves.toBeUndefined();
	});
	it("handles registration rejection without an unhandled startup error", async () => {
		vi.stubGlobal("window", { location: { protocol: "https:" } });
		const register = vi.fn(async () => {
			throw new Error("Browser policy rejected registration.");
		});
		vi.stubGlobal("navigator", { serviceWorker: { register } });
		await expect(registerBrowserServiceWorker()).resolves.toBeUndefined();
		expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js");
	});
});
