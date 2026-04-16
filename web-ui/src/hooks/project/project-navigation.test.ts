import { describe, expect, it } from "vitest";
import { isDirectoryPickerUnavailableErrorMessage, parseRemovedProjectPathFromStreamError } from "./project-navigation";

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

// ---------------------------------------------------------------------------
// isDirectoryPickerUnavailableErrorMessage
// ---------------------------------------------------------------------------

describe("isDirectoryPickerUnavailableErrorMessage", () => {
	it("detects zenity/kdialog unavailable", () => {
		expect(
			isDirectoryPickerUnavailableErrorMessage(
				'Could not open directory picker. Install "zenity" or "kdialog" and try again.',
			),
		).toBe(true);
	});

	it("detects PowerShell unavailable", () => {
		expect(
			isDirectoryPickerUnavailableErrorMessage(
				'Could not open directory picker. Install PowerShell ("powershell" or "pwsh") and try again.',
			),
		).toBe(true);
	});

	it("detects osascript unavailable", () => {
		expect(
			isDirectoryPickerUnavailableErrorMessage(
				'Could not open directory picker. Command "osascript" is not available.',
			),
		).toBe(true);
	});

	it("does not treat cancellation as unavailable", () => {
		expect(isDirectoryPickerUnavailableErrorMessage("No directory was selected.")).toBe(false);
	});

	it("returns false for null and empty", () => {
		expect(isDirectoryPickerUnavailableErrorMessage(null)).toBe(false);
		expect(isDirectoryPickerUnavailableErrorMessage("")).toBe(false);
		expect(isDirectoryPickerUnavailableErrorMessage(undefined)).toBe(false);
	});
});
