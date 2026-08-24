import { describe, expect, it } from "vitest";
import { parseRemovedProjectPathFromStreamError, resolveProjectDirectoryPickerDecision } from "./project-navigation";

describe("resolveProjectDirectoryPickerDecision", () => {
	it("selects a returned path", () => {
		expect(resolveProjectDirectoryPickerDecision({ ok: true, path: "/repo", outcome: "native" })).toEqual({
			kind: "selected",
			path: "/repo",
		});
	});

	it("distinguishes cancellation from the manual-path fallback", () => {
		expect(
			resolveProjectDirectoryPickerDecision({
				ok: false,
				path: null,
				reason: "cancelled",
				error: "No directory was selected.",
			}),
		).toEqual({ kind: "cancelled" });
		expect(
			resolveProjectDirectoryPickerDecision({
				ok: false,
				path: null,
				reason: "native_ui_unavailable",
				error: "Picker unavailable",
			}),
		).toEqual({ kind: "manual_path" });
	});

	it("preserves a typed picker failure message", () => {
		expect(
			resolveProjectDirectoryPickerDecision({
				ok: false,
				path: null,
				reason: "launch_failed",
				error: "Picker crashed",
			}),
		).toEqual({ kind: "failed", message: "Picker crashed" });
	});
});

// ---------------------------------------------------------------------------
// parseRemovedProjectPathFromStreamError
// ---------------------------------------------------------------------------

describe("parseRemovedProjectPathFromStreamError", () => {
	it("extracts removed project path", () => {
		expect(
			parseRemovedProjectPathFromStreamError("Project no longer exists on disk and was removed: /tmp/project"),
		).toBe("/tmp/project");
	});

	it("trims whitespace from extracted path", () => {
		expect(
			parseRemovedProjectPathFromStreamError("Project no longer exists on disk and was removed:  /tmp/project  "),
		).toBe("/tmp/project");
	});

	it("returns null when prefix is not present", () => {
		expect(parseRemovedProjectPathFromStreamError("Something else happened")).toBeNull();
	});

	it("returns null for null input", () => {
		expect(parseRemovedProjectPathFromStreamError(null)).toBeNull();
	});
});
