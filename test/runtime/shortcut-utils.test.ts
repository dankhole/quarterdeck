import { describe, expect, it } from "vitest";
import { areRuntimeProjectShortcutsEqual } from "../../src/config";
import type { RuntimeProjectShortcut } from "../../src/core";

describe("areRuntimeProjectShortcutsEqual", () => {
	const shortcutA: RuntimeProjectShortcut = { label: "Build", command: "npm run build" };
	const shortcutB: RuntimeProjectShortcut = { label: "Test", command: "npm test" };

	it("returns true for two empty arrays", () => {
		expect(areRuntimeProjectShortcutsEqual([], [])).toBe(true);
	});

	it("returns true for identical single-element arrays", () => {
		expect(areRuntimeProjectShortcutsEqual([shortcutA], [{ ...shortcutA }])).toBe(true);
	});

	it("returns false when lengths differ", () => {
		expect(areRuntimeProjectShortcutsEqual([shortcutA], [shortcutA, shortcutB])).toBe(false);
	});

	it("returns false when labels differ", () => {
		expect(areRuntimeProjectShortcutsEqual([shortcutA], [{ ...shortcutA, label: "Deploy" }])).toBe(false);
	});

	it("returns false when commands differ", () => {
		expect(areRuntimeProjectShortcutsEqual([shortcutA], [{ ...shortcutA, command: "npm run lint" }])).toBe(false);
	});

	it("returns true when both icons are undefined", () => {
		expect(areRuntimeProjectShortcutsEqual([shortcutA], [{ ...shortcutA }])).toBe(true);
	});

	it("treats undefined icon and empty string icon as equal", () => {
		const withUndefined: RuntimeProjectShortcut = { label: "X", command: "y" };
		const withEmpty: RuntimeProjectShortcut = { label: "X", command: "y", icon: "" };
		expect(areRuntimeProjectShortcutsEqual([withUndefined], [withEmpty])).toBe(true);
	});

	it("returns false when icons differ", () => {
		const a: RuntimeProjectShortcut = { label: "X", command: "y", icon: "rocket" };
		const b: RuntimeProjectShortcut = { label: "X", command: "y", icon: "star" };
		expect(areRuntimeProjectShortcutsEqual([a], [b])).toBe(false);
	});

	it("is order-sensitive", () => {
		expect(areRuntimeProjectShortcutsEqual([shortcutA, shortcutB], [shortcutB, shortcutA])).toBe(false);
	});

	it("returns true for multiple identical shortcuts in order", () => {
		expect(areRuntimeProjectShortcutsEqual([shortcutA, shortcutB], [{ ...shortcutA }, { ...shortcutB }])).toBe(true);
	});
});
