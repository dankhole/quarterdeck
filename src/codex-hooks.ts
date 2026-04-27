import type { RuntimeHookEvent } from "./core";
import { buildQuarterdeckCommandParts, quoteShellArg } from "./core";

export const CODEX_HOOKS_FEATURE_NAME = "codex_hooks";

function buildHookCommand(event: RuntimeHookEvent, metadata?: { source?: string }): string {
	const parts = buildQuarterdeckCommandParts(["hooks", "ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	return parts.map(quoteShellArg).join(" ");
}

type CodexHookCommand = {
	type: "command";
	command: string;
};

type CodexHookMatcherGroup = {
	matcher?: string;
	hooks: CodexHookCommand[];
};

type CodexHooksConfig = {
	SessionStart: CodexHookMatcherGroup[];
	PreToolUse: CodexHookMatcherGroup[];
	PermissionRequest: CodexHookMatcherGroup[];
	PostToolUse: CodexHookMatcherGroup[];
	UserPromptSubmit: CodexHookMatcherGroup[];
	Stop: CodexHookMatcherGroup[];
};

export function buildCodexHooksConfig(): CodexHooksConfig {
	return {
		SessionStart: [
			{
				// Capture launch/resume metadata without moving review-ready cards
				// back to running. Codex can emit SessionStart around session
				// maintenance flows such as compaction, where no agent turn starts.
				matcher: "startup|resume",
				hooks: [{ type: "command", command: buildHookCommand("activity", { source: "codex" }) }],
			},
		],
		PreToolUse: [
			{
				matcher: "*",
				hooks: [{ type: "command", command: buildHookCommand("activity", { source: "codex" }) }],
			},
		],
		PermissionRequest: [
			{
				matcher: "*",
				hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "codex" }) }],
			},
		],
		PostToolUse: [
			{
				matcher: "*",
				hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "codex" }) }],
			},
		],
		UserPromptSubmit: [
			{
				hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "codex" }) }],
			},
		],
		Stop: [
			{
				// Known limitation: current Codex hook payloads do not identify
				// root-agent vs subagent Stop events. Mapping Stop to review keeps
				// main-agent completion working, but subagent-heavy sessions can
				// produce premature review transitions until upstream exposes a
				// reliable discriminator. Tracked in docs/todo.md.
				hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "codex" }) }],
			},
		],
	};
}

export function serializeCodexTomlValue(value: unknown): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => serializeCodexTomlValue(item)).join(", ")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.map(([key, entryValue]) => `${key} = ${serializeCodexTomlValue(entryValue)}`)
			.join(", ")}}`;
	}
	throw new Error(`Unsupported Codex hook config value: ${String(value)}`);
}

export function buildCodexHookConfigOverrides(): string[] {
	return Object.entries(buildCodexHooksConfig()).flatMap(([eventName, hookGroups]) => [
		"-c",
		`hooks.${eventName}=${serializeCodexTomlValue(hookGroups)}`,
	]);
}
