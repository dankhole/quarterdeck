import { describe, expect, it } from "vitest";
import {
	type LaunchEnvironment,
	resolveInternalRuntimeHost,
	resolveLaunchPolicy,
	supportsDesktopHost,
} from "../../src/launch-policy.js";

const mac: LaunchEnvironment = {
	platform: "darwin",
	arch: "arm64",
	osRelease: "25.0.0",
	graphicalSession: true,
	desktopHelper: false,
	internalRuntimeAllowed: false,
};
const plain = { runtimeFlags: false };

describe("desktop-only CLI launch policy", () => {
	it.each([undefined, null, "", "127.0.0.1", " 127.0.0.1 "])(
		"binds internal runtime host %s to literal loopback",
		(host) => {
			expect(resolveInternalRuntimeHost(host)).toBe("127.0.0.1");
		},
	);
	it.each(["0.0.0.0", "::", "::1", "localhost", "127.0.0.2", "192.168.1.10", "example.com"])(
		"rejects unsupported internal bind %s",
		(host) => {
			expect(() => resolveInternalRuntimeHost(host)).toThrow("bind only to 127.0.0.1");
		},
	);
	it("always selects installed desktop validation for a supported GUI host", () => {
		expect(resolveLaunchPolicy(plain, mac)).toEqual({ mode: "desktop" });
		expect(resolveLaunchPolicy({ ...plain, desktop: true }, mac)).toEqual({ mode: "desktop" });
	});
	it("never treats runtime tuning flags as launch authority", () => {
		expect(() => resolveLaunchPolicy({ runtimeFlags: true }, { ...mac, internalRuntimeAllowed: true })).toThrow(
			"require an explicitly authorized",
		);
	});
	it("rejects a headless ordinary launch instead of creating a browser runtime", () => {
		expect(() => resolveLaunchPolicy(plain, { ...mac, graphicalSession: false })).toThrow("local graphical session");
	});
	it.each([
		{ platform: "linux" },
		{ platform: "win32", osRelease: "6.3.0" },
		{ arch: "ia32" },
		{ osRelease: "21.6.0" },
		{ osRelease: "unknown" },
	])("rejects unsupported product hosts %j", (override) => {
		const host = { ...mac, ...override };
		expect(supportsDesktopHost(host)).toBe(false);
		expect(() => resolveLaunchPolicy(plain, host)).toThrow("macOS 13+");
	});
	it.each(["x64", "arm64"])("supports Windows desktop on %s", (arch) => {
		expect(resolveLaunchPolicy(plain, { ...mac, platform: "win32", arch, osRelease: "10.0.26100" }).mode).toBe(
			"desktop",
		);
	});
	it("requires both explicit internal intent and a development/lab allowance", () => {
		expect(() => resolveLaunchPolicy({ ...plain, internalRuntime: true }, mac)).toThrow("restricted");
		expect(
			resolveLaunchPolicy(
				{ runtimeFlags: true, internalRuntime: true },
				{ ...mac, platform: "linux", graphicalSession: false, internalRuntimeAllowed: true },
			),
		).toEqual({ mode: "runtime" });
	});
	it("requires the explicit internal flag for desktop helpers and never recurses", () => {
		const helper = { ...mac, desktopHelper: true };
		expect(() => resolveLaunchPolicy(plain, helper)).toThrow("requires --internal-runtime");
		expect(resolveLaunchPolicy({ ...plain, internalRuntime: true }, helper)).toEqual({ mode: "runtime" });
		expect(() => resolveLaunchPolicy({ ...plain, desktop: true, internalRuntime: true }, helper)).toThrow(
			"cannot be combined",
		);
	});
});
