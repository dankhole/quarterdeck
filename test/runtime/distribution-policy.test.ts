import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	hasBrowserInstallPreference,
	isDesktopRelease,
	usesDesktopLaunchDefault,
	wantsDesktopInstallation,
} from "../../src/distribution-policy.js";
import { createTempDir } from "../utilities/temp-dir.js";

vi.mock("../../package.json", () => ({ default: { quarterdeck: { desktopRelease: "adhoc-v1" } } }));

describe("desktop distribution capability", () => {
	it("recognizes public ad-hoc and signed contracts without accepting unknown capabilities", async () => {
		expect(isDesktopRelease("adhoc-v1")).toBe(true);
		expect(isDesktopRelease("signed-v1")).toBe(true);
		for (const capability of ["browser-only", "desktop", true, {}, null, "adhoc-v2", "signed-v2"]) {
			expect(isDesktopRelease(capability)).toBe(false);
		}
		const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
		expect(metadata.quarterdeck.desktopRelease).toBe("adhoc-v1");
		expect(isDesktopRelease()).toBe(true);
	});
	it("keeps browser-only releases inert and explicit installation available", () => {
		expect(wantsDesktopInstallation(undefined, false)).toBe(false);
		expect(wantsDesktopInstallation(undefined, true)).toBe(true);
		expect(wantsDesktopInstallation("desktop", false)).toBe(true);
		for (const mode of ["browser", "unknown"]) {
			expect(wantsDesktopInstallation(mode, true)).toBe(false);
		}
	});
	it("keeps source and transient npx packages browser-first", async () => {
		const sandbox = createTempDir("quarterdeck-distribution-");
		try {
			for (const path of [
				"source",
				"_npx/123/node_modules/quarterdeck",
				"local/node_modules/quarterdeck",
				"notlib/node_modules/quarterdeck",
			]) {
				const root = join(sandbox.path, path);
				await mkdir(root, { recursive: true });
				expect(await usesDesktopLaunchDefault(root)).toBe(false);
			}
		} finally {
			sandbox.cleanup();
		}
	});
	it("defaults a global package to desktop when scripts were skipped, without writing or repairing", async () => {
		const sandbox = createTempDir("quarterdeck-distribution-");
		try {
			const root = join(sandbox.path, "lib/node_modules/quarterdeck");
			await mkdir(root, { recursive: true });
			expect(await usesDesktopLaunchDefault(root)).toBe(true);
			expect(await hasBrowserInstallPreference(root)).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	});
	it("retains a browser opt-out across package replacement, but not another prefix", async () => {
		const sandbox = createTempDir("quarterdeck-distribution-");
		try {
			const root = join(sandbox.path, "prefix/lib/node_modules/quarterdeck");
			const other = join(sandbox.path, "other/lib/node_modules/quarterdeck");
			await mkdir(root, { recursive: true });
			await mkdir(other, { recursive: true });
			await writeFile(
				join(dirname(root), ".quarterdeck-install-mode.json"),
				JSON.stringify({ schemaVersion: 1, mode: "browser" }),
			);
			await rm(root, { recursive: true });
			await mkdir(root);
			expect(await usesDesktopLaunchDefault(root)).toBe(false);
			expect(await usesDesktopLaunchDefault(other)).toBe(true);
		} finally {
			sandbox.cleanup();
		}
	});
	it.each(["not JSON", '{"mode":"browser"}', '{"schemaVersion":1,"mode":"desktop"}'])(
		"does not turn malformed preference %s into silent browser fallback",
		async (contents) => {
			const sandbox = createTempDir("quarterdeck-distribution-");
			try {
				const root = join(sandbox.path, "lib/node_modules/quarterdeck");
				await mkdir(root, { recursive: true });
				await writeFile(join(dirname(root), ".quarterdeck-install-mode.json"), contents);
				expect(await usesDesktopLaunchDefault(root)).toBe(true);
			} finally {
				sandbox.cleanup();
			}
		},
	);
});
