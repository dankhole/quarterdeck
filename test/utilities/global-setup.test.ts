import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import setup from "../global-setup";

describe("root test home", { concurrent: false }, () => {
	afterEach(() => vi.unstubAllEnvs());

	it("starts workers with a synthetic home and no inherited state override", () => {
		expect(basename(process.env.HOME ?? "")).toMatch(/^quarterdeck-suite-home-/);
		expect(process.env.USERPROFILE).toBe(process.env.HOME);
		expect(homedir()).toBe(process.env.HOME);
		expect(process.env.QUARTERDECK_STATE_HOME).toBeUndefined();
		expect(process.env.QUARTERDECK_DESKTOP_SESSION_ID).toBeUndefined();
	});

	it.each(["present", "absent"] as const)("cleans up and restores %s original home values", async (original) => {
		vi.stubEnv("HOME", original === "present" ? process.env.HOME : undefined);
		vi.stubEnv("USERPROFILE", original === "present" ? process.env.USERPROFILE : undefined);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const teardown = setup();
		const temporaryHome = process.env.HOME ?? "";
		try {
			expect(temporaryHome).not.toBe(previousHome);
			expect(process.env.USERPROFILE).toBe(temporaryHome);
			writeFileSync(join(temporaryHome, "fixture.txt"), "synthetic test data");
		} finally {
			await teardown();
		}
		expect(existsSync(temporaryHome)).toBe(false);
		expect(process.env.HOME).toBe(previousHome);
		expect(process.env.USERPROFILE).toBe(previousUserProfile);
	});
});
