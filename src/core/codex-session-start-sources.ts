/**
 * Canonical Codex native `SessionStart` source values. Defined once here, zod-free,
 * so the lightweight hook entry (`dist/hooks.js`) can validate a Codex session-start
 * source without bundling `core/api/task-session.ts`'s schema surface.
 * `core/api/task-session.ts`'s `runtimeCodexSessionStartSourceSchema` is
 * `z.enum(CODEX_SESSION_START_SOURCES)` — keep this as the single source of truth.
 */
export const CODEX_SESSION_START_SOURCES = ["startup", "resume", "clear", "compact", "fork"] as const;
export type CodexSessionStartSource = (typeof CODEX_SESSION_START_SOURCES)[number];
