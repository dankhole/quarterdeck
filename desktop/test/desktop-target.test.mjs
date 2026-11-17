import { describe, expect, it } from "vitest";
import { requireNativeDesktopTarget } from "../scripts/paths.mjs";

describe("native desktop staging target", () => {
	it.each(["darwin", "win32"])("admits only a native matching %s architecture", (platform) => {
		for (const arch of ["x64", "arm64"]) {
			expect(() => requireNativeDesktopTarget(arch, platform, arch)).not.toThrow();
		}
		expect(() => requireNativeDesktopTarget("arm64", platform, "x64")).toThrow("native matching");
	});
	it("rejects unsupported hosts and architectures", () => {
		expect(() => requireNativeDesktopTarget("x64", "linux", "x64")).toThrow("native matching");
		expect(() => requireNativeDesktopTarget("ia32", "win32", "ia32")).toThrow();
	});
});
