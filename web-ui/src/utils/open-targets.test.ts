import { describe, expect, it } from "vitest";
import {
	buildOpenCommand,
	getOpenTargetOption,
	getOpenTargetOptions,
	normalizeOpenTargetId,
	resolveOpenTargetPlatform,
} from "@/utils/open-targets";

describe("open-targets", () => {
	it("filters unsupported options on windows", () => {
		const windowsOptions = getOpenTargetOptions("windows");
		expect(windowsOptions.some((option) => option.id === "iterm2")).toBe(false);
		expect(windowsOptions.some((option) => option.id === "xcode")).toBe(false);
		expect(windowsOptions.some((option) => option.id === "vscode-insiders")).toBe(true);
		expect(windowsOptions.some((option) => option.id === "finder")).toBe(true);
	});

	it("places VS Code Insiders as second from bottom on macOS", () => {
		const macOptions = getOpenTargetOptions("mac");
		expect(macOptions.at(-2)?.id).toBe("vscode-insiders");
	});

	it("falls back to default option when selected target is unsupported on platform", () => {
		const selected = getOpenTargetOption("iterm2", "linux");
		expect(selected.id).toBe("vscode");
	});

	it("builds a macOS app-open command", () => {
		expect(buildOpenCommand("vscode", "/tmp/repo", "mac")).toBe("open -a 'Visual Studio Code' '/tmp/repo'");
	});

	it("builds a linux file manager command", () => {
		expect(buildOpenCommand("finder", "/tmp/my repo", "linux")).toBe("xdg-open '/tmp/my repo'");
	});

	it("builds a macOS VS Code Insiders command", () => {
		expect(buildOpenCommand("vscode-insiders", "/tmp/repo", "mac")).toBe(
			"open -a 'Visual Studio Code - Insiders' '/tmp/repo'",
		);
	});

	it("builds a windows file explorer command", () => {
		expect(buildOpenCommand("finder", "C:\\Users\\dev\\my repo", "windows")).toBe(
			'explorer "C:\\Users\\dev\\my repo"',
		);
	});

	it("builds a windows VS Code Insiders command", () => {
		expect(buildOpenCommand("vscode-insiders", "C:\\Users\\dev\\my repo", "windows")).toBe(
			'code-insiders "C:\\Users\\dev\\my repo"',
		);
	});

	it("falls back to default command when target is unsupported on windows", () => {
		expect(buildOpenCommand("iterm2", "C:\\Users\\dev\\my repo", "windows")).toBe('code "C:\\Users\\dev\\my repo"');
	});
});

describe("open-targets (new coverage)", () => {
	describe("normalizeOpenTargetId", () => {
		it("returns null for null input", () => {
			expect(normalizeOpenTargetId(null)).toBeNull();
		});

		it("returns null for empty string", () => {
			expect(normalizeOpenTargetId("")).toBeNull();
		});

		it("returns null for unknown string", () => {
			expect(normalizeOpenTargetId("vim")).toBeNull();
		});

		it("normalizes 'ghostie' to 'ghostty'", () => {
			expect(normalizeOpenTargetId("ghostie")).toBe("ghostty");
		});

		it("normalizes 'intellij_idea' to 'intellijidea'", () => {
			expect(normalizeOpenTargetId("intellij_idea")).toBe("intellijidea");
		});

		it("passes through valid ids unchanged", () => {
			expect(normalizeOpenTargetId("vscode")).toBe("vscode");
			expect(normalizeOpenTargetId("cursor")).toBe("cursor");
			expect(normalizeOpenTargetId("zed")).toBe("zed");
		});
	});

	describe("resolveOpenTargetPlatform", () => {
		it("returns 'other' when navigator is undefined", () => {
			const origNavigator = globalThis.navigator;
			Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
			expect(resolveOpenTargetPlatform()).toBe("other");
			Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true });
		});
	});

	describe("getOpenTargetOptions platform labels", () => {
		it("shows 'File Explorer' for finder on windows", () => {
			const windowsOptions = getOpenTargetOptions("windows");
			const finder = windowsOptions.find((o) => o.id === "finder");
			expect(finder?.label).toBe("File Explorer");
		});

		it("shows 'File Manager' for finder on linux", () => {
			const linuxOptions = getOpenTargetOptions("linux");
			const finder = linuxOptions.find((o) => o.id === "finder");
			expect(finder?.label).toBe("File Manager");
		});

		it("shows 'Finder' for finder on mac", () => {
			const macOptions = getOpenTargetOptions("mac");
			const finder = macOptions.find((o) => o.id === "finder");
			expect(finder?.label).toBe("Finder");
		});
	});

	describe("getOpenTargetOption", () => {
		it("returns the requested option when supported", () => {
			const option = getOpenTargetOption("cursor", "mac");
			expect(option.id).toBe("cursor");
			expect(option.label).toBe("Cursor");
		});

		it("returns the platform default when target is unsupported", () => {
			const option = getOpenTargetOption("ghostty", "windows");
			expect(option.id).toBe("vscode");
		});
	});

	describe("buildOpenCommand — linux targets", () => {
		it("builds code command for vscode", () => {
			expect(buildOpenCommand("vscode", "/repo", "linux")).toBe("code '/repo'");
		});

		it("builds cursor command", () => {
			expect(buildOpenCommand("cursor", "/repo", "linux")).toBe("cursor '/repo'");
		});

		it("builds windsurf command", () => {
			expect(buildOpenCommand("windsurf", "/repo", "linux")).toBe("windsurf '/repo'");
		});

		it("builds zed command", () => {
			expect(buildOpenCommand("zed", "/repo", "linux")).toBe("zed '/repo'");
		});

		it("builds code-insiders command", () => {
			expect(buildOpenCommand("vscode-insiders", "/repo", "linux")).toBe("code-insiders '/repo'");
		});
	});

	describe("buildOpenCommand — windows targets", () => {
		it("builds code command for vscode", () => {
			expect(buildOpenCommand("vscode", "C:\\repo", "windows")).toBe('code "C:\\repo"');
		});

		it("builds cursor command", () => {
			expect(buildOpenCommand("cursor", "C:\\repo", "windows")).toBe('cursor "C:\\repo"');
		});

		it("builds windsurf command", () => {
			expect(buildOpenCommand("windsurf", "C:\\repo", "windows")).toBe('windsurf "C:\\repo"');
		});

		it("builds zed command", () => {
			expect(buildOpenCommand("zed", "C:\\repo", "windows")).toBe('zed "C:\\repo"');
		});
	});

	describe("buildOpenCommand — mac targets", () => {
		it("builds finder open command (no app name)", () => {
			expect(buildOpenCommand("finder", "/repo", "mac")).toBe("open '/repo'");
		});

		it("builds terminal command", () => {
			expect(buildOpenCommand("terminal", "/repo", "mac")).toBe("open -a 'Terminal' '/repo'");
		});

		it("builds iterm2 command with fallback", () => {
			expect(buildOpenCommand("iterm2", "/repo", "mac")).toBe(
				"(open -a 'iTerm' '/repo' || open -a 'iTerm2' '/repo')",
			);
		});

		it("builds ghostty command with fallback", () => {
			expect(buildOpenCommand("ghostty", "/repo", "mac")).toBe(
				"(open -a 'Ghostty' '/repo' || open -a 'Ghostie' '/repo')",
			);
		});

		it("builds warp command", () => {
			expect(buildOpenCommand("warp", "/repo", "mac")).toBe("open -a 'Warp' '/repo'");
		});

		it("builds xcode command", () => {
			expect(buildOpenCommand("xcode", "/repo", "mac")).toBe("open -a 'Xcode' '/repo'");
		});

		it("builds intellij command with fallback", () => {
			expect(buildOpenCommand("intellijidea", "/repo", "mac")).toBe(
				"(open -a 'IntelliJ IDEA' '/repo' || open -a 'IntelliJ IDEA CE' '/repo')",
			);
		});

		it("builds cursor command", () => {
			expect(buildOpenCommand("cursor", "/repo", "mac")).toBe("open -a 'Cursor' '/repo'");
		});

		it("builds windsurf command", () => {
			expect(buildOpenCommand("windsurf", "/repo", "mac")).toBe("open -a 'Windsurf' '/repo'");
		});

		it("builds zed command", () => {
			expect(buildOpenCommand("zed", "/repo", "mac")).toBe("open -a 'Zed' '/repo'");
		});
	});

	describe("buildOpenCommand — 'other' platform", () => {
		it("falls back to xdg-open for finder", () => {
			expect(buildOpenCommand("finder", "/repo", "other")).toBe("xdg-open '/repo'");
		});

		it("shows File Manager label for finder on other", () => {
			const option = getOpenTargetOption("finder", "other");
			expect(option.label).toBe("File Manager");
		});
	});

	describe("shell quoting", () => {
		it("escapes single quotes in path on mac", () => {
			expect(buildOpenCommand("vscode", "/tmp/it's a repo", "mac")).toBe(
				"open -a 'Visual Studio Code' '/tmp/it'\"'\"'s a repo'",
			);
		});

		it("escapes double quotes in path on windows", () => {
			expect(buildOpenCommand("vscode", 'C:\\Users\\"special"', "windows")).toBe('code "C:\\Users\\""special"""');
		});
	});
});
