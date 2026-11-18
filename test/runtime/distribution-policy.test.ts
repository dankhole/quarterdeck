import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { isDesktopRelease } from "../../src/distribution-policy.js";

vi.mock("../../package.json", () => ({
	default: { quarterdeck: { desktopRelease: "adhoc-v1", windowsDesktopRelease: "unsigned-v1" } },
}));

describe("desktop distribution capability", () => {
	it("recognizes supported desktop contracts, not removed browser-only or unknown capabilities", () => {
		for (const capability of ["adhoc-v1", "signed-v1", "unsigned-v1"])
			expect(isDesktopRelease(capability)).toBe(true);
		for (const capability of ["browser-only", "desktop", true, {}, null, "adhoc-v2", "signed-v2"])
			expect(isDesktopRelease(capability)).toBe(false);
		expect(isDesktopRelease()).toBe(true);
	});
	it("declares desktop releases for both supported platforms", async () => {
		const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
		expect(isDesktopRelease(metadata.quarterdeck.desktopRelease)).toBe(true);
		expect(isDesktopRelease(metadata.quarterdeck.windowsDesktopRelease)).toBe(true);
	});
});
