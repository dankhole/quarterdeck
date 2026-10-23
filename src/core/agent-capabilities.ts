import type { RuntimeAgentId } from "./api/shared.js";

/**
 * Agent ids that load a Quarterdeck-managed launch-scoped lifecycle hook or
 * extension/plugin and drive the canonical Running/Review/Needs Input/
 * Interrupted/Error state machine through durable native hooks. Adding a
 * fifth native agent is a single-point change here plus its catalog entry.
 */
export const NATIVE_LIFECYCLE_AGENT_IDS = [
	"claude",
	"codex",
	"pi",
	"opencode",
] as const satisfies readonly RuntimeAgentId[];

const NATIVE_LIFECYCLE_AGENT_ID_SET: ReadonlySet<string> = new Set(NATIVE_LIFECYCLE_AGENT_IDS);

export function isNativeLifecycleAgentId(id: string | null | undefined): id is RuntimeAgentId {
	return id !== null && id !== undefined && NATIVE_LIFECYCLE_AGENT_ID_SET.has(id);
}

/**
 * Providers whose launch-scoped extension/plugin reports run-scoped
 * AgentStart/AgentSettled lifecycles instead of a per-turn Stop (the Pi
 * model, also used by opencode). Shared ordering and retirement logic keys
 * off this instead of a literal `"pi"` check so a run-scoped provider is a
 * single-point addition.
 */
export function isRunScopedExtensionProvider(source: string | null | undefined): source is "pi" | "opencode" {
	return source === "pi" || source === "opencode";
}
