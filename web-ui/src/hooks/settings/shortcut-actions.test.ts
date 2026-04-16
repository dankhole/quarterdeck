import { describe, expect, it } from "vitest";
import { getNextShortcutLabel, validateNewShortcut } from "@/hooks/settings/shortcut-actions";

describe("getNextShortcutLabel", () => {
	it("returns base label when no collision", () => {
		expect(getNextShortcutLabel("Build", ["Test", "Deploy"])).toBe("Build");
	});

	it("appends suffix 2 on first collision", () => {
		expect(getNextShortcutLabel("Build", ["Build"])).toBe("Build 2");
	});

	it("increments suffix past existing suffixed labels", () => {
		expect(getNextShortcutLabel("Build", ["Build", "Build 2", "Build 3"])).toBe("Build 4");
	});

	it("is case-insensitive", () => {
		expect(getNextShortcutLabel("build", ["BUILD"])).toBe("build 2");
	});

	it("trims labels for comparison", () => {
		expect(getNextShortcutLabel("Build", ["  Build  "])).toBe("Build 2");
	});

	it("ignores empty labels", () => {
		expect(getNextShortcutLabel("Build", ["", "  "])).toBe("Build");
	});
});

describe("validateNewShortcut", () => {
	it("returns validated shortcut with normalized command", () => {
		const result = validateNewShortcut("  npm test  ", "Test", []);
		expect(result).toEqual({ ok: true, label: "Test", command: "npm test" });
	});

	it("returns error for empty command", () => {
		const result = validateNewShortcut("", "Test", []);
		expect(result).toEqual({ ok: false, message: "Command is required." });
	});

	it("returns error for whitespace-only command", () => {
		const result = validateNewShortcut("   ", "Test", []);
		expect(result).toEqual({ ok: false, message: "Command is required." });
	});

	it("defaults label to 'Run' when empty", () => {
		const result = validateNewShortcut("npm test", "", []);
		expect(result).toEqual({ ok: true, label: "Run", command: "npm test" });
	});

	it("defaults label to 'Run' when whitespace-only", () => {
		const result = validateNewShortcut("npm test", "   ", []);
		expect(result).toEqual({ ok: true, label: "Run", command: "npm test" });
	});

	it("deduplicates label against existing", () => {
		const result = validateNewShortcut("npm test", "Build", ["Build"]);
		expect(result).toEqual({ ok: true, label: "Build 2", command: "npm test" });
	});
});
