import { createHash } from "node:crypto";

import type { RuntimeHookEvent } from "./core";
import { buildQuarterdeckCommandParts, quoteShellArg } from "./core";

export const CODEX_HOOKS_FEATURE_NAME = "hooks";
export const CODEX_HOOK_TIMEOUT_SECONDS = 5;

export type CodexHookConfigEvent =
	| "SessionStart"
	| "PreToolUse"
	| "PermissionRequest"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "Stop";

const CODEX_HOOK_EVENT_LABELS = {
	SessionStart: "session_start",
	PreToolUse: "pre_tool_use",
	PermissionRequest: "permission_request",
	PostToolUse: "post_tool_use",
	UserPromptSubmit: "user_prompt_submit",
	Stop: "stop",
} as const satisfies Record<CodexHookConfigEvent, string>;

function buildHookCommand(event: RuntimeHookEvent, metadata?: { source?: string; reliable?: boolean }): string {
	const subcommand = metadata?.reliable || event !== "activity" ? "ingest" : "notify";
	const parts = buildQuarterdeckCommandParts(["hooks", subcommand, "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	return parts.map(quoteShellArg).join(" ");
}

type CodexHookCommand = {
	type: "command";
	command: string;
	timeout: number;
};

type CodexHookMatcherGroup = {
	matcher?: string;
	hooks: CodexHookCommand[];
};

export type CodexHooksConfig = Record<CodexHookConfigEvent, CodexHookMatcherGroup[]>;

export type CodexHookTrustEntry = {
	key: string;
	trustedHash: string;
};

function buildCodexCommandHook(
	event: RuntimeHookEvent,
	metadata?: { source?: string; reliable?: boolean },
): CodexHookCommand {
	return {
		type: "command",
		command: buildHookCommand(event, metadata),
		timeout: CODEX_HOOK_TIMEOUT_SECONDS,
	};
}

export function buildCodexHooksConfig(): CodexHooksConfig {
	return {
		SessionStart: [
			{
				// Capture launch/resume metadata without moving review-ready cards
				// back to running. Codex can emit SessionStart around session
				// maintenance flows such as compaction, where no agent turn starts.
				matcher: "startup|resume",
				hooks: [buildCodexCommandHook("activity", { source: "codex", reliable: true })],
			},
		],
		PreToolUse: [
			{
				matcher: "*",
				hooks: [buildCodexCommandHook("activity", { source: "codex" })],
			},
		],
		PermissionRequest: [
			{
				matcher: "*",
				hooks: [buildCodexCommandHook("to_review", { source: "codex" })],
			},
		],
		PostToolUse: [
			{
				matcher: "*",
				hooks: [buildCodexCommandHook("to_in_progress", { source: "codex" })],
			},
		],
		UserPromptSubmit: [
			{
				hooks: [buildCodexCommandHook("to_in_progress", { source: "codex" })],
			},
		],
		Stop: [
			{
				// Codex 0.142.5+ dispatches root Stop and SubagentStop separately.
				// Quarterdeck only maps root-turn completion to review.
				hooks: [buildCodexCommandHook("to_review", { source: "codex" })],
			},
		],
	};
}

type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

function canonicalizeJsonValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeJsonValue(entry));
	}
	if (value && typeof value === "object") {
		const sorted: JsonObject = {};
		for (const key of Object.keys(value).sort()) {
			const entry = value[key];
			if (entry !== undefined) {
				sorted[key] = canonicalizeJsonValue(entry);
			}
		}
		return sorted;
	}
	return value;
}

function versionForCodexHookIdentity(identity: JsonObject): string {
	const canonical = JSON.stringify(canonicalizeJsonValue(identity));
	const hash = createHash("sha256").update(canonical).digest("hex");
	return `sha256:${hash}`;
}

function codexSessionFlagsConfigSource(): string {
	return process.platform === "win32" ? "C:\\<session-flags>\\config.toml" : "/<session-flags>/config.toml";
}

function buildCodexHookTrustIdentity(
	eventName: CodexHookConfigEvent,
	group: CodexHookMatcherGroup,
	hook: CodexHookCommand,
): JsonObject {
	const identity: JsonObject = {
		event_name: CODEX_HOOK_EVENT_LABELS[eventName],
		hooks: [
			{
				async: false,
				command: hook.command,
				timeout: hook.timeout,
				type: hook.type,
			},
		],
	};
	if (group.matcher !== undefined) {
		identity.matcher = group.matcher;
	}
	return identity;
}

export function buildCodexHookTrustEntries(config: CodexHooksConfig = buildCodexHooksConfig()): CodexHookTrustEntry[] {
	const configSource = codexSessionFlagsConfigSource();
	const entries: CodexHookTrustEntry[] = [];
	for (const [eventName, hookGroups] of Object.entries(config) as Array<
		[CodexHookConfigEvent, CodexHookMatcherGroup[]]
	>) {
		const eventLabel = CODEX_HOOK_EVENT_LABELS[eventName];
		hookGroups.forEach((group, groupIndex) => {
			group.hooks.forEach((hook, hookIndex) => {
				entries.push({
					key: `${configSource}:${eventLabel}:${groupIndex}:${hookIndex}`,
					trustedHash: versionForCodexHookIdentity(buildCodexHookTrustIdentity(eventName, group, hook)),
				});
			});
		});
	}
	return entries;
}

export function buildCodexHookTrustStateConfigValue(config: CodexHooksConfig = buildCodexHooksConfig()): string {
	const entries = buildCodexHookTrustEntries(config);
	return `{${entries
		.map(({ key, trustedHash }) => `${JSON.stringify(key)} = {trusted_hash = ${JSON.stringify(trustedHash)}}`)
		.join(", ")}}`;
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
	const config = buildCodexHooksConfig();
	return [
		"-c",
		`hooks.state=${buildCodexHookTrustStateConfigValue(config)}`,
		...(Object.entries(config) as Array<[CodexHookConfigEvent, CodexHookMatcherGroup[]]>).flatMap(
			([eventName, hookGroups]) => ["-c", `hooks.${eventName}=${serializeCodexTomlValue(hookGroups)}`],
		),
	];
}
