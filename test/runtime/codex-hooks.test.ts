import { describe, expect, it } from "vitest";

import { buildCodexHookConfigOverrides, buildCodexHooksConfig, serializeCodexTomlValue } from "../../src/codex-hooks";

describe("serializeCodexTomlValue", () => {
	it("JSON-quotes plain strings", () => {
		expect(serializeCodexTomlValue("hello")).toBe(`"hello"`);
	});

	it("escapes embedded double quotes", () => {
		expect(serializeCodexTomlValue(`say "hi"`)).toBe(`"say \\"hi\\""`);
	});

	it("escapes backslashes", () => {
		expect(serializeCodexTomlValue(`C:\\tools\\codex`)).toBe(`"C:\\\\tools\\\\codex"`);
	});

	it("preserves unicode in strings", () => {
		// JSON-stringify emits the unicode codepoint as-is, which matches TOML spec-conformant
		// decoders like the one Codex uses for `-c` overrides.
		expect(serializeCodexTomlValue("café — 🚀")).toBe(`"café — 🚀"`);
	});

	it("stringifies numbers and booleans", () => {
		expect(serializeCodexTomlValue(42)).toBe("42");
		expect(serializeCodexTomlValue(0)).toBe("0");
		expect(serializeCodexTomlValue(true)).toBe("true");
		expect(serializeCodexTomlValue(false)).toBe("false");
	});

	it("serializes empty arrays as []", () => {
		expect(serializeCodexTomlValue([])).toBe("[]");
	});

	it("serializes arrays of primitives with comma separators", () => {
		expect(serializeCodexTomlValue(["a", 1, true])).toBe(`["a", 1, true]`);
	});

	it("serializes plain objects as inline tables", () => {
		expect(serializeCodexTomlValue({ type: "command", command: "echo hi" })).toBe(
			`{type = "command", command = "echo hi"}`,
		);
	});

	it("recursively serializes nested objects that themselves contain arrays/objects", () => {
		expect(
			serializeCodexTomlValue({
				matcher: "*",
				hooks: [{ type: "command", command: `echo "hi"` }],
			}),
		).toBe(`{matcher = "*", hooks = [{type = "command", command = "echo \\"hi\\""}]}`);
	});

	it("throws on unsupported values (null/undefined)", () => {
		expect(() => serializeCodexTomlValue(null)).toThrow(/Unsupported Codex hook config value/);
		expect(() => serializeCodexTomlValue(undefined)).toThrow(/Unsupported Codex hook config value/);
	});
});

describe("buildCodexHookConfigOverrides", () => {
	it("emits one `-c` flag per configured event", () => {
		const overrides = buildCodexHookConfigOverrides();
		const eventCount = Object.keys(buildCodexHooksConfig()).length;

		// Alternating `-c` + key=value pairs.
		expect(overrides.length).toBe(eventCount * 2);
		for (let i = 0; i < overrides.length; i += 2) {
			expect(overrides[i]).toBe("-c");
		}
	});

	it("prefixes each override value with the event's hooks path", () => {
		const overrides = buildCodexHookConfigOverrides();
		const values = overrides.filter((_, index) => index % 2 === 1);
		const expectedEvents = Object.keys(buildCodexHooksConfig());
		const seenEvents = values.map((value) => value.split("=", 1)[0]);
		expect(seenEvents).toEqual(expectedEvents.map((event) => `hooks.${event}`));
	});

	it("SessionStart matcher excludes Codex's `clear` event", () => {
		const { SessionStart } = buildCodexHooksConfig();
		for (const group of SessionStart) {
			expect(group.matcher).toBe("startup|resume");
			expect(group.matcher).not.toContain("clear");
		}
	});

	it("maps SessionStart to activity rather than running", () => {
		const { SessionStart } = buildCodexHooksConfig();
		expect(SessionStart).toHaveLength(1);
		expect(SessionStart[0]?.hooks[0]?.command).toContain("'--event' 'activity'");
		expect(SessionStart[0]?.hooks[0]?.command).not.toContain("'--event' 'to_in_progress'");
	});

	it("uses one PostToolUse command because transition ingest also stores metadata", () => {
		const { PostToolUse } = buildCodexHooksConfig();
		expect(PostToolUse).toHaveLength(1);
		expect(PostToolUse[0]?.hooks).toHaveLength(1);
		expect(PostToolUse[0]?.hooks[0]?.command).toContain("'--event' 'to_in_progress'");
	});
});
