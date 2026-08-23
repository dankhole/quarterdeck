import { describe, expect, it } from "vitest";

import {
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
		expect(windowsOptions.some((option) => option.id === "rider")).toBe(true);
		expect(windowsOptions.some((option) => option.id === "vscode-insiders")).toBe(true);
		expect(windowsOptions.some((option) => option.id === "finder")).toBe(true);
	});

	it("places VS Code Insiders as second from bottom on macOS", () => {
		const macOptions = getOpenTargetOptions("mac");
		expect(macOptions.at(-2)?.id).toBe("vscode-insiders");
	});

	it("falls back to the platform default when a selected target is unsupported", () => {
		expect(getOpenTargetOption("iterm2", "linux").id).toBe("vscode");
		expect(getOpenTargetOption("ghostty", "windows").id).toBe("vscode");
	});

	it("uses platform-appropriate file manager labels", () => {
		expect(getOpenTargetOption("finder", "mac").label).toBe("Finder");
		expect(getOpenTargetOption("finder", "windows").label).toBe("File Explorer");
		expect(getOpenTargetOption("finder", "linux").label).toBe("File Manager");
		expect(getOpenTargetOption("finder", "other").label).toBe("File Manager");
	});

	it("returns the requested option when it is supported", () => {
		const option = getOpenTargetOption("cursor", "mac");
		expect(option.id).toBe("cursor");
		expect(option.label).toBe("Cursor");
	});

	it("normalizes legacy persisted target ids", () => {
		expect(normalizeOpenTargetId("ghostie")).toBe("ghostty");
		expect(normalizeOpenTargetId("intellij_idea")).toBe("intellijidea");
		expect(normalizeOpenTargetId("jetbrains_rider")).toBe("rider");
	});

	it("accepts current ids and rejects absent or unknown ids", () => {
		expect(normalizeOpenTargetId("vscode")).toBe("vscode");
		expect(normalizeOpenTargetId("cursor")).toBe("cursor");
		expect(normalizeOpenTargetId("rider")).toBe("rider");
		expect(normalizeOpenTargetId("zed")).toBe("zed");
		expect(normalizeOpenTargetId(null)).toBeNull();
		expect(normalizeOpenTargetId("")).toBeNull();
		expect(normalizeOpenTargetId("vim")).toBeNull();
	});

	it("returns other when navigator is unavailable", () => {
		const originalNavigator = globalThis.navigator;
		Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
		try {
			expect(resolveOpenTargetPlatform()).toBe("other");
		} finally {
			Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
		}
	});
});
