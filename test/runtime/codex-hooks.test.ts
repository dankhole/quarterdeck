import { describe, expect, it } from "vitest";

import {
	buildCodexHookConfigOverrides,
	buildCodexHooksConfig,
	buildCodexHookTrustEntries,
	CODEX_HOOK_TIMEOUT_SECONDS,
	type CodexHooksConfig,
	serializeCodexTomlValue,
} from "../../src/codex-hooks";
import { buildQuarterdeckCommandLine } from "../../src/core";

const SESSION_FLAGS_CONFIG_SOURCE =
	process.platform === "win32" ? "C:\\<session-flags>\\config.toml" : "/<session-flags>/config.toml";

function hookCommand(event: string, options: { reliable?: boolean } = {}): string {
	const subcommand = options.reliable || event !== "activity" ? "ingest" : "notify";
	return buildQuarterdeckCommandLine(["hooks", subcommand, "--event", event, "--source", "codex"]);
}

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
				hooks: [{ type: "command", command: `echo "hi"`, timeout: CODEX_HOOK_TIMEOUT_SECONDS }],
			}),
		).toBe(`{matcher = "*", hooks = [{type = "command", command = "echo \\"hi\\"", timeout = 5}]}`);
	});

	it("throws on unsupported values (null/undefined)", () => {
		expect(() => serializeCodexTomlValue(null)).toThrow(/Unsupported Codex hook config value/);
		expect(() => serializeCodexTomlValue(undefined)).toThrow(/Unsupported Codex hook config value/);
	});
});

describe("buildCodexHookConfigOverrides", () => {
	it("emits one `-c` flag for trust state plus one per configured event", () => {
		const overrides = buildCodexHookConfigOverrides();
		const eventCount = Object.keys(buildCodexHooksConfig()).length;

		// Alternating `-c` + key=value pairs.
		expect(overrides.length).toBe((eventCount + 1) * 2);
		for (let i = 0; i < overrides.length; i += 2) {
			expect(overrides[i]).toBe("-c");
		}
	});

	it("pre-seeds trust state before event hook overrides", () => {
		const overrides = buildCodexHookConfigOverrides();
		const values = overrides.filter((_, index) => index % 2 === 1);

		expect(values[0]?.split("=", 1)[0]).toBe("hooks.state");
		expect(values[0]).toContain(JSON.stringify(`${SESSION_FLAGS_CONFIG_SOURCE}:permission_request:0:0`));
		expect(values[0]).toContain("trusted_hash");
		expect(values[0]).toContain("sha256:");
	});

	it("prefixes each event override value with the event's hooks path", () => {
		const overrides = buildCodexHookConfigOverrides();
		const values = overrides.filter((_, index) => index % 2 === 1);
		const expectedEvents = Object.keys(buildCodexHooksConfig());
		const seenEvents = values.slice(1).map((value) => value.split("=", 1)[0]);
		expect(seenEvents).toEqual(expectedEvents.map((event) => `hooks.${event}`));
	});

	it("sets a bounded timeout on every generated command hook", () => {
		const config = buildCodexHooksConfig();
		for (const hookGroups of Object.values(config)) {
			for (const group of hookGroups) {
				for (const hook of group.hooks) {
					expect(hook.timeout).toBe(CODEX_HOOK_TIMEOUT_SECONDS);
				}
			}
		}
	});

	it("matches Codex's currentHash formula for launch-scoped hook identities", () => {
		const config: CodexHooksConfig = {
			SessionStart: [],
			PreToolUse: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: "true", timeout: CODEX_HOOK_TIMEOUT_SECONDS }],
				},
			],
			PermissionRequest: [],
			PostToolUse: [],
			UserPromptSubmit: [],
			PreCompact: [],
			PostCompact: [],
			Stop: [
				{
					hooks: [{ type: "command", command: "true", timeout: CODEX_HOOK_TIMEOUT_SECONDS }],
				},
			],
		};

		expect(buildCodexHookTrustEntries(config)).toEqual([
			{
				key: `${SESSION_FLAGS_CONFIG_SOURCE}:pre_tool_use:0:0`,
				trustedHash: "sha256:850b1716209f4847d4d149c3cdda0149f6b98907148354b02778ee6509ec09e9",
			},
			{
				key: `${SESSION_FLAGS_CONFIG_SOURCE}:stop:0:0`,
				trustedHash: "sha256:99551a51b888f6dc725f1199663b7b1e1ef9bb9b9cab0612d84e5e9218aca6f5",
			},
		]);
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
		expect(SessionStart[0]?.hooks[0]?.command).toBe(hookCommand("activity", { reliable: true }));
		expect(SessionStart[0]?.hooks[0]?.command).not.toBe(hookCommand("activity"));
		expect(SessionStart[0]?.hooks[0]?.command).not.toBe(hookCommand("to_in_progress"));
	});

	it("keeps SessionStart on reliable ingest so session_meta resume ids are not best-effort", () => {
		const { SessionStart, PreToolUse } = buildCodexHooksConfig();

		expect(SessionStart[0]?.hooks[0]?.command).toBe(hookCommand("activity", { reliable: true }));
		expect(PreToolUse[0]?.hooks[0]?.command).toBe(hookCommand("activity"));
	});

	it("uses one PostToolUse command because transition ingest also stores metadata", () => {
		const { PostToolUse } = buildCodexHooksConfig();
		expect(PostToolUse).toHaveLength(1);
		expect(PostToolUse[0]?.hooks).toHaveLength(1);
		expect(PostToolUse[0]?.hooks[0]?.command).toBe(hookCommand("to_in_progress"));
	});

	it("reports manual compaction as activity without claiming a task transition", () => {
		const { PreCompact, PostCompact } = buildCodexHooksConfig();

		expect(PreCompact).toHaveLength(1);
		expect(PreCompact[0]?.matcher).toBe("manual");
		expect(PreCompact[0]?.hooks[0]?.command).toBe(hookCommand("activity"));
		expect(PostCompact).toHaveLength(1);
		expect(PostCompact[0]?.matcher).toBe("manual");
		expect(PostCompact[0]?.hooks[0]?.command).toBe(hookCommand("activity"));
	});
});
