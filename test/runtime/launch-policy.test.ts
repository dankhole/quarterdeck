import { describe, expect, it } from "vitest";
import { type LaunchEnvironment, resolveLaunchPolicy, supportsDesktopHost } from "../../src/launch-policy.js";

const mac: LaunchEnvironment = {
	platform: "darwin",
	arch: "arm64",
	osRelease: "25.0.0",
	graphicalSession: true,
	desktopHelper: false,
	desktopDefault: false,
};
const plain = { runtimeFlags: false, noOpen: false };

describe("CLI launch policy", () => {
	it("defaults to browser mode on supported graphical Macs without requiring an installed app", () => {
		expect(resolveLaunchPolicy(plain, mac)).toEqual({ mode: "runtime", openBrowser: true });
	});
	it("defaults desktop-capable global GUI installs to desktop without repairing or falling back", () => {
		expect(resolveLaunchPolicy(plain, { ...mac, desktopDefault: true })).toEqual({
			mode: "desktop",
			openBrowser: false,
		});
	});
	it("opens the native app for an explicit desktop launch even in a browser-only release", () => {
		expect(resolveLaunchPolicy({ ...plain, desktop: true }, mac)).toEqual({ mode: "desktop", openBrowser: false });
	});
	it("retains explicit browser and runtime flag paths", () => {
		const desktopMac = { ...mac, desktopDefault: true };
		expect(resolveLaunchPolicy({ ...plain, browser: true }, desktopMac)).toEqual({
			mode: "runtime",
			openBrowser: true,
		});
		expect(resolveLaunchPolicy({ ...plain, runtimeFlags: true }, desktopMac)).toEqual({
			mode: "runtime",
			openBrowser: true,
		});
		expect(resolveLaunchPolicy({ ...plain, noOpen: true }, desktopMac)).toEqual({
			mode: "runtime",
			openBrowser: false,
		});
	});
	it("defaults to a headless runtime and explains explicit desktop requests", () => {
		const headless = { ...mac, graphicalSession: false, desktopDefault: true };
		expect(resolveLaunchPolicy(plain, headless)).toEqual({ mode: "runtime", openBrowser: false });
		expect(() => resolveLaunchPolicy({ ...plain, desktop: true }, headless)).toThrow("graphical session");
	});
	it.each([
		{ platform: "linux" },
		{ platform: "win32" },
		{ arch: "ia32" },
		{ osRelease: "21.6.0" },
		{ osRelease: "unknown" },
	])("retains browser/runtime on unsupported hosts %j", (override) => {
		const host = { ...mac, desktopDefault: true, ...override };
		expect(supportsDesktopHost(host)).toBe(false);
		expect(resolveLaunchPolicy(plain, host).mode).toBe("runtime");
		expect(() => resolveLaunchPolicy({ ...plain, desktop: true }, host)).toThrow("macOS 13");
	});
	it.each(["darwin", "linux", "win32"])("never recurses from a desktop runtime helper on %s", (platform) => {
		const helper = { ...mac, platform, desktopHelper: true, desktopDefault: true };
		expect(resolveLaunchPolicy(plain, helper)).toEqual({
			mode: "runtime",
			openBrowser: false,
		});
		expect(() => resolveLaunchPolicy({ ...plain, desktop: true }, helper)).toThrow("helper");
	});
	it("rejects explicit desktop conflicts", () => {
		expect(() => resolveLaunchPolicy({ ...plain, desktop: true, runtimeFlags: true }, mac)).toThrow(
			"cannot be combined",
		);
		expect(() => resolveLaunchPolicy({ ...plain, desktop: true, browser: true }, mac)).toThrow("cannot be combined");
	});
});
