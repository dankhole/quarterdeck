# SDD: Task Conversation Summaries + Title Generation

**Feature**: #17 from `docs/planned-features.md`
**Date**: 2026-04-07
**Status**: Draft
**Prior Research**: `docs/research/2026-04-06-task-conversation-summary-approaches.md`

## Goal

When a Claude agent session ends (Stop hook), parse the Claude Code transcript JSONL to extract the last meaningful assistant message and store it as a conversation summary on the task session. Summaries accumulate across sessions (retaining first + most recent entries, capped at ~2000 chars total) and are surfaced in card hover tooltips and optionally on the card face. The existing title regeneration button is updated to use summaries as richer context for LLM-based title generation.

## Scope

### In Scope

- CLI-side transcript parsing for Claude agents on every Stop hook event
- New `conversationSummaries` field on `RuntimeTaskSessionSummary` with retention policy
- `enrichClaudeStopMetadata` function following the `enrichCodexReviewMetadata` pattern
- Card hover tooltip updated to prefer summary over `finalMessage`
- Global setting to show truncated summary on card face
- Title regeneration updated to pass summary as context to the LLM call
- Summaries persist on trashed cards

### Out of Scope

- Codex/other agent enrichment (follow-up — see [Future: Codex Integration](#future-codex-integration))
- LLM-based summary generation (summaries are raw transcript extraction, zero model calls)
- Automatic title updates (user manually triggers title regeneration)
- Summary editing UI

## Architecture

### Data Flow

```
Claude Stop hook fires
  │ pipes stdin JSON with transcript_path
  ▼
quarterdeck hooks ingest (CLI process)
  │ parseHooksIngestArgs() → HooksIngestArgs with payload.transcript_path
  │ enrichCodexReviewMetadata() → no-op (source !== "codex")
  │ enrichClaudeStopMetadata() → NEW: reads transcript JSONL, extracts last assistant message
  │   sets metadata.finalMessage + metadata.conversationSummaryText
  ▼
ingestHookEvent() → tRPC call to hooks.ingest
  ▼
hooks-api.ts handler
  │ manager.applyHookActivity(taskId, metadata)
  │ manager.appendConversationSummary(taskId, entry) → NEW
  ▼
Session summary updated with conversationSummaries[]
  │ WebSocket broadcast → UI re-renders
  ▼
Card tooltip shows latest summary
Title regeneration uses summaries as context
```

### Key Design Decision: CLI-Side Enrichment

The enrichment happens CLI-side (in the `quarterdeck hooks ingest` process), NOT server-side. This follows the established `enrichCodexReviewMetadata` pattern and avoids:
- Passing raw `transcript_path` through the tRPC API (the server shouldn't need to know about agent file locations)
- The server reading files from agent-owned directories
- Adding a new field to the `hooks.ingest` tRPC input schema just for a file path

The CLI process already has filesystem access to the transcript (it runs in the agent's cwd) and the payload is available before the tRPC call.

## Implementation Phases

### Phase 1: Schema + Summary Storage

**Goal**: Add the `conversationSummaries` field to the session summary schema and the server-side storage/retention logic.

#### 1.1 Schema Changes — `src/core/api-contract.ts`

Add a new schema for individual summary entries and a collection on the session summary:

```typescript
// After runtimeTaskHookActivitySchema (line ~234)

export const conversationSummaryEntrySchema = z.object({
   /** The extracted assistant message text, capped at 500 chars. */
   text: z.string(),
   /** Timestamp when this summary was captured. */
   capturedAt: z.number(),
   /** Which session stop event produced this (first, latest, etc.). */
   sessionIndex: z.number().int().nonnegative(),
});
export type ConversationSummaryEntry = z.infer<typeof conversationSummaryEntrySchema>;
```

Add to `runtimeTaskSessionSummarySchema` (after `previousTurnCheckpoint`, line ~260):

```typescript
conversationSummaries: z.array(conversationSummaryEntrySchema).default([]),
```

#### 1.2 Session Manager — `src/terminal/session-manager.ts`

Add a new method `appendConversationSummary` on `TerminalSessionManager`:

```typescript
appendConversationSummary(taskId: string, entry: { text: string; capturedAt: number }): RuntimeTaskSessionSummary | null
```

The method takes only `{ text, capturedAt }` — it assigns `sessionIndex` internally by incrementing from the highest existing `sessionIndex` in the collection (or starting at 0). This avoids callers needing to know about existing indices.

Note: The `conversationSummaryEntrySchema` still includes `sessionIndex` as a persisted field — it is auto-assigned by this method, not by callers.

**Retention policy** (applied inside this method after appending the new entry):
1. **Truncate first**: If the new entry's `text` exceeds 500 chars, truncate it to 500 chars with `"…"` suffix before storing. In the normal flow, the transcript parser already caps at 500 chars (see Phase 2.1), so this is a **safety net** for entries constructed outside the parser (e.g., future non-Claude agents or tests). The method should check `text.length > 500` before truncating, not `>=`, to avoid double-ellipsis artifacts when text is exactly 501 chars from the parser's `"…"` suffix.
2. **Count limit**: Keep at most 5 entries total. Always retain the first entry (index 0) and the latest entry (just appended). Drop the oldest non-first entries until count <= 5.
3. **Character cap**: Sum all `text` field lengths. If total exceeds 2000 chars, drop the oldest non-first entry (excluding the latest) and repeat until total <= 2000 or only first + latest remain.

The count limit is applied before the character cap. This ensures predictable behavior: count-prune first, then char-prune within the survivors.

#### 1.3 Hook Activity Flow — `src/trpc/hooks-api.ts`

The `conversationSummaryEntry` needs to flow from CLI metadata to the session manager. Two options:

**Option A (chosen)**: Pass the summary entry as a new field on `RuntimeTaskHookActivity`. Add to `runtimeTaskHookActivitySchema` (`api-contract.ts:225`):

```typescript
conversationSummaryText: z.string().nullable().default(null),
```

Then in `hooks-api.ts`, **before** the `broadcastRuntimeWorkspaceStateUpdated` call (line 115), after `manager.applyHookActivity(taskId, body.metadata)` (line 112), check for the new field and call `appendConversationSummary`:

```typescript
if (body.metadata) {
   manager.applyHookActivity(taskId, body.metadata);
}

if (body.metadata?.conversationSummaryText) {
   manager.appendConversationSummary(taskId, {
      text: body.metadata.conversationSummaryText,
      capturedAt: Date.now(),
   });
}

void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
```

Note: `appendConversationSummary` must be called **before** the broadcast so the WebSocket update includes the new summary. The method auto-assigns `sessionIndex` internally — callers only provide `{ text, capturedAt }`.

This keeps the tRPC API surface minimal — just one new nullable string field on the existing metadata object.

**Type propagation note**: Adding `conversationSummaryText` to `runtimeTaskHookActivitySchema` automatically makes it available in `HooksIngestArgs.metadata` because that type is defined as `Partial<RuntimeTaskHookActivity>`. No additional type changes are needed for the CLI-side enrichment to set the field.

**Validation layer note**: `parseHookIngestRequest` in `api-validation.ts` (line 261-269) manually reconstructs the metadata object with a hardcoded allowlist of fields. The new `conversationSummaryText` field MUST be added to this allowlist, otherwise it will be silently stripped before the tRPC call.

**Pre-existing bug**: The existing `toolInputSummary` field (on `runtimeTaskHookActivitySchema` since its creation) is also missing from this allowlist. Fix it at the same time by adding both fields:

```typescript
const metadata = parsed.metadata
   ? {
         activityText: parsed.metadata.activityText?.trim(),
         toolName: parsed.metadata.toolName?.trim(),
         toolInputSummary: parsed.metadata.toolInputSummary?.trim() ?? null,
         finalMessage: parsed.metadata.finalMessage?.trim(),
         hookEventName: parsed.metadata.hookEventName?.trim(),
         notificationType: parsed.metadata.notificationType?.trim(),
         source: parsed.metadata.source?.trim(),
         conversationSummaryText: parsed.metadata.conversationSummaryText?.trim() || null,
      }
   : undefined;
```

Note: `conversationSummaryText` uses `|| null` (not `?? null`) so that a whitespace-only string that trims to `""` becomes `null` rather than being stored as an empty string.

Note: `capturedAt` is set server-side in `hooks-api.ts` (via `Date.now()` at the point of ingestion), NOT on the CLI side. The CLI only provides the raw text; the server timestamps it when storing.

### Phase 2: Claude Transcript Parsing + CLI Enrichment

**Goal**: Parse Claude Code transcript JSONL files and enrich hook metadata with the extracted summary.

#### 2.1 Transcript Parser — `src/commands/claude-transcript-parser.ts` (new file)

Create a focused module for parsing Claude Code transcript JSONL files:

```typescript
/**
 * Parse a Claude Code transcript JSONL file and extract the last meaningful
 * assistant message. Skips tool call acknowledgments, tool results, and
 * system messages.
 *
 * The Claude Code transcript format (as of 2026-04) uses one JSON object per
 * line. Each object has at minimum a `type` field. Assistant text messages have:
 *   { "type": "assistant", "message": { "role": "assistant", "content": [...] } }
 * where content items with type "text" contain the actual message text.
 *
 * Tool use entries have content items with type "tool_use" and should be
 * skipped when looking for meaningful text messages.
 *
 * NOTE: This format is internal to Claude Code and may change. If parsing
 * fails, return null gracefully — never throw.
 *
 * --- Future: Codex Integration ---
 * Codex transcripts use a different JSONL format (see codex-hook-events.ts).
 * When unifying enrichment, create a shared interface:
 *   interface TranscriptParser {
 *     extractLastAssistantMessage(filePath: string): Promise<string | null>;
 *   }
 * with per-agent implementations (ClaudeTranscriptParser, CodexTranscriptParser).
 */

export async function extractLastAssistantMessage(transcriptPath: string): Promise<string | null>
```

**Implementation details:**
- Read the file with `fs.readFile` (not streaming — transcripts are typically <1MB)
- Split by newlines, take only the **last 50 lines** (simple `lines.slice(-50)`), then parse each line as JSON
- Iterate **backwards** through the 50-line window to find the last assistant message with meaningful text content
- "Meaningful" = has at least one content item of type `"text"` with non-empty text that is NOT just a tool call acknowledgment (e.g., skip messages that are only "I'll read that file" before a tool_use)
- **Heuristic for skipping tool acknowledgments**: If the assistant message's text content is <30 chars AND the message also contains a `tool_use` content item, skip it — it's likely a preamble to a tool call, not a meaningful summary
- When an assistant message has multiple `"text"` content items, concatenate them (space-separated) first, then apply the 500-char cap
- Cap extracted text at 500 chars with `"…"` suffix. This is the **authoritative truncation point** — the storage layer (`appendConversationSummary`) also enforces a 500-char cap, but only as a safety net for entries constructed without going through the parser. In the normal flow, the parser's truncation means the storage layer's check is a no-op (text is already <=500 chars, no double-ellipsis artifact).
- Return `null` on any error (file not found, parse error, no meaningful message found)
- If no meaningful message is found in the last 50 lines, return `null`

#### 2.2 Actual Claude Code Transcript Format

**IMPORTANT**: The transcript format described above is based on research and Claude Code documentation patterns. Before implementation, the implementing agent MUST:

1. Find a real transcript file at `~/.claude/projects/*/sessions/*.jsonl`
2. Read the last 10-20 lines to verify the actual schema
3. Adapt the parser to match reality

Expected structure per line (verify against real file):
```jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me..."},{"type":"tool_use","id":"...","name":"Read","input":{...}}]}}
{"type":"tool_result","tool_use_id":"...","content":[{"type":"text","text":"..."}]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here's what I found..."}]}}
```

#### 2.3 CLI Enrichment — `src/commands/hooks.ts`

Add `enrichClaudeStopMetadata` function, modeled on `enrichCodexReviewMetadata` (line 460-502):

```typescript
/**
 * Enrich Claude Stop hook metadata with a conversation summary extracted from
 * the transcript JSONL file.
 *
 * Follows the same pattern as enrichCodexReviewMetadata — reads agent-specific
 * files on the CLI side before the tRPC call to the server.
 *
 * --- Future: Codex Integration ---
 * When unifying enrichment across agents, merge this with enrichCodexReviewMetadata
 * into a single enrichAgentMetadata function that dispatches based on source:
 *   async function enrichAgentMetadata(args, cwd): Promise<HooksIngestArgs> {
 *     switch (args.metadata?.source) {
 *       case "claude": return enrichClaudeStopMetadata(args);
 *       case "codex": return enrichCodexReviewMetadata(args, cwd);
 *       default: return args;
 *     }
 *   }
 */
async function enrichClaudeStopMetadata(args: HooksIngestArgs): Promise<HooksIngestArgs>
```

**Source identification**: The Claude adapter's Stop hook config passes `--source claude` as an explicit CLI flag (see `agent-session-adapters.ts:514`), so `source` is always present in the metadata for Claude Stop hooks. As a secondary mechanism, `inferHookSourceFromPayload` also returns `"claude"` when `transcript_path` contains `/.claude/` (see `hooks.ts:303-309`). The explicit flag is the primary mechanism; inference is a fallback for payloads that arrive without `--source`.

**Logic:**
1. Guard: only activate for `to_review` events (the Stop hook maps to `to_review`) — check event first
2. Guard: only activate when `source === "claude"` (inferred or explicit) — check source second
3. Extract `transcript_path` from `args.payload` (check both `transcript_path` and `transcriptPath` keys)
4. If no transcript path, return args unchanged
5. Call `extractLastAssistantMessage(transcriptPath)`
6. If extraction succeeds, set:
   - `metadata.conversationSummaryText` = extracted text (capped at 500 chars)
   - `metadata.finalMessage` = extracted text (if `finalMessage` is not already set — don't overwrite SubagentStop's `last_assistant_message`)
   - `metadata.activityText` = `"Final: {text}"` (if not already set)
7. Return enriched args

**Integration point** — add to the enrichment pipeline in `runHooksIngest` only (line 734). Do NOT add to `runHooksNotify` — that function is for Codex/Gemini file watchers, not Claude Stop hooks. Claude Stop hooks go through `runHooksIngest`.

```typescript
// Current (runHooksIngest, line 733-734):
const parsedArgs = parseHooksIngestArgs(event, options, payloadArg, stdinPayload);
args = await enrichCodexReviewMetadata(parsedArgs, process.cwd());

// Updated:
const parsedArgs = parseHooksIngestArgs(event, options, payloadArg, stdinPayload);
const codexEnriched = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
try {
   args = await enrichClaudeStopMetadata(codexEnriched);
} catch {
   // If enrichment crashes, fall back to unenriched args so the hook is still ingested.
   args = codexEnriched;
}
```

Both enrichments are guarded by source, so they're no-ops for non-matching agents. Order doesn't matter.

**Error isolation**: The `enrichClaudeStopMetadata` call is wrapped in a try/catch at the call site. If the enrichment function throws (e.g., unexpected transcript format, filesystem error not caught internally), the hook ingest proceeds with the unenriched args. This ensures a transcript parsing regression never prevents hook ingestion. Note: `enrichClaudeStopMetadata` itself already returns `null` for most error cases (see Phase 2.1), so the try/catch is a defense-in-depth safety net for truly unexpected failures.

### Phase 3: UI — Tooltip + Card Face Setting

**Goal**: Surface summaries in the UI via card hover tooltips and an optional card face display.

#### 3.1 Card Hover Tooltip — `web-ui/src/components/board-card.tsx`

Update `getCardHoverTooltip` (line 93-107) to prefer the latest conversation summary over `finalMessage`:

```typescript
function getCardHoverTooltip(summary: RuntimeTaskSessionSummary | undefined): string | null {
   if (!summary) return null;
   if (summary.state === "running") return "Thinking…";

   // Prefer conversation summary (richer context) over raw finalMessage
   const latestSummary = summary.conversationSummaries?.at(-1)?.text?.trim();
   if (latestSummary) {
      const maxLength = 200;
      return latestSummary.length > maxLength ? `${latestSummary.slice(0, maxLength)}…` : latestSummary;
   }

   // Fall back to finalMessage for agents that don't have summaries yet
   const finalMessage = summary.latestHookActivity?.finalMessage?.trim();
   if (finalMessage) {
      const maxLength = 200;
      return finalMessage.length > maxLength ? `${finalMessage.slice(0, maxLength)}…` : finalMessage;
   }
   return null;
}
```

This is backwards-compatible — existing sessions without summaries still show `finalMessage`.

**Backwards-compatibility note**: Although `conversationSummaries` has a Zod `.default([])` on the schema, previously persisted session JSON files will not have this field. The optional chaining (`summary.conversationSummaries?.at(-1)`) is intentional to handle these pre-existing persisted sessions that were written before this feature existed. Zod defaults only apply when parsing through the schema; direct property access on deserialized JSON will see `undefined` for old sessions.

**Testing note**: `getCardHoverTooltip` is module-scoped (not exported). Tests for tooltip behavior (T26-T28) should either: (a) export it as a named export for testability, or (b) test indirectly by rendering `BoardCard` and inspecting the tooltip content in the DOM. Option (a) is preferred for unit test simplicity — add `export` to the function since it's pure logic with no side effects.

#### 3.2 Global Setting: Show Summary on Card — `src/config/runtime-config.ts` + UI

Add a new runtime setting following the `agentAutonomousModeEnabled` pattern. The runtime config uses plain TypeScript interfaces, not Zod schemas.

**Runtime config changes** (`src/config/runtime-config.ts`):

1. Add `showSummaryOnCards?: boolean` to `RuntimeGlobalConfigFileShape` interface
2. Add `showSummaryOnCards: boolean` to `RuntimeConfigState` interface
3. Add `showSummaryOnCards?: boolean` to `RuntimeConfigUpdateInput` interface
4. Add a default constant: `const DEFAULT_SHOW_SUMMARY_ON_CARDS = false;`
5. Wire through all functions that handle config fields (follow `agentAutonomousModeEnabled` exactly):
   - `toRuntimeConfigState`: `showSummaryOnCards: normalizeBoolean(globalConfig?.showSummaryOnCards, DEFAULT_SHOW_SUMMARY_ON_CARDS)`
   - `writeRuntimeGlobalConfigFile`: accept `showSummaryOnCards?: boolean` in config param, normalize it, include in payload when `hasOwnKey` or differs from default
   - `createRuntimeConfigStateFromValues`: accept and normalize `showSummaryOnCards` in input
   - `saveRuntimeConfig`: pass through to `writeRuntimeGlobalConfigFile` and `createRuntimeConfigStateFromValues`
   - `updateRuntimeConfig`: merge with current, include in `hasChanges` check, pass to write/create
   - `updateGlobalRuntimeConfig`: same as `updateRuntimeConfig`

**API contract schema changes** (`src/core/api-contract.ts`):

The config value must flow through the Zod schemas that define the tRPC API boundary:

1. Add `showSummaryOnCards: z.boolean()` to `runtimeConfigResponseSchema` (line ~546) — the server sends the current value to the UI
2. Add `showSummaryOnCards: z.boolean().optional()` to `runtimeConfigSaveRequestSchema` (line ~565) — the UI sends updates back

**Agent registry changes** (`src/terminal/agent-registry.ts`):

`buildRuntimeConfigResponse` (line ~96) constructs the `RuntimeConfigResponse` from `RuntimeConfigState`. Add:

```typescript
showSummaryOnCards: runtimeConfig.showSummaryOnCards,
```

**Settings UI** — add a toggle in `web-ui/src/components/runtime-settings-dialog.tsx`:
- Label: "Show conversation summary on cards"
- Description: "Display a truncated preview of the agent's latest summary below the title"
- Default: off

#### 3.3 Card Face Summary Display — `web-ui/src/components/board-card.tsx`

**Prop threading**: The `showSummaryOnCards` boolean must flow from the runtime config down to `BoardCard`:

1. **`web-ui/src/components/quarterdeck-board.tsx`**: Already has access to `RuntimeConfigResponse` via `useRuntimeConfig`. Read `config.showSummaryOnCards` and pass it as a prop to each `BoardColumn`.
2. **`web-ui/src/components/board-column.tsx`**: Accept `showSummaryOnCards: boolean` prop and forward it to each `BoardCard`.
3. **`web-ui/src/components/board-card.tsx`**: Accept `showSummaryOnCards: boolean` prop.

**`latestSummaryText` computation**: Extract from the last conversation summary entry, truncate to 150 chars with `"…"` suffix, and use CSS `line-clamp-2` as a visual backup for rendering:

```typescript
const latestSummaryText = useMemo(() => {
   const raw = session?.conversationSummaries?.at(-1)?.text?.trim();
   if (!raw) return null;
   return raw.length > 150 ? `${raw.slice(0, 150)}…` : raw;
}, [session?.conversationSummaries]);
```

When the `showSummaryOnCards` prop is true, render the latest summary text below the card title (after line ~419, before the hover actions):

```tsx
{showSummaryOnCards && latestSummaryText && (
   <p className="text-xs text-text-secondary line-clamp-2 mt-1">
      {latestSummaryText}
   </p>
)}
```

- Use `line-clamp-2` for max 2 lines of preview
- `text-xs text-text-secondary` for subtle appearance
- Show for all column states including trash (summaries persist)
- The setting value arrives as a prop, NOT read from a hook inside `BoardCard`

### Phase 4: Title Regeneration Enhancement

**Goal**: Pass conversation summaries as richer context to the existing title generation LLM call.

#### 4.1 Update `regenerateTaskTitle` — `src/trpc/app-router.ts:454-474`

Update the context building to include summaries:

```typescript
regenerateTaskTitle: workspaceProcedure
   .input(z.object({ taskId: z.string() }))
   .output(z.object({ ok: z.boolean(), title: z.string().nullable() }))
   .mutation(async ({ ctx, input }) => {
      const state = await ctx.workspaceApi.loadState(ctx.workspaceScope);
      const card = findCardInBoard(state.board, input.taskId);
      if (!card) {
         throw new TRPCError({ code: "NOT_FOUND", message: `Task "${input.taskId}" not found.` });
      }

      const session = state.sessions[card.id];
      const summaries = session?.conversationSummaries ?? [];
      const latestSummary = summaries.at(-1)?.text?.slice(0, 500) ?? null;

      // Prefer conversation summary (what the agent actually did) over
      // finalMessage (which may be a terse "Done!" or tool acknowledgment)
      const agentContext = latestSummary
         ?? session?.latestHookActivity?.finalMessage?.slice(0, 500)
         ?? null;

      const context = agentContext
         ? `${card.prompt}\n\nAgent summary: ${agentContext}`
         : card.prompt;

      const title = await generateTaskTitle(context);
      if (!title) {
         return { ok: false, title: null };
      }
      ctx.workspaceApi.notifyTaskTitleUpdated(ctx.workspaceScope, input.taskId, title);
      return { ok: true, title };
   }),
```

The key changes:
1. The label changes from `"Agent response:"` to `"Agent summary:"` for **both** paths (summary and finalMessage fallback). The existing code at line 467 uses `"Agent response:"` — this becomes `"Agent summary:"` uniformly.
2. Prefers `conversationSummaries` over `finalMessage` as context source.

The `generateTaskTitle` function and LLM call remain unchanged — it already handles variable-length context. The `slice(0, 500)` matches the per-entry 500-char cap from the transcript parser, so in practice the slice is a no-op for summary entries but acts as a safety net for raw `finalMessage` strings.

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/core/api-contract.ts` | Modify | Add `conversationSummaryEntrySchema`, add `conversationSummaries` to session summary, add `conversationSummaryText` to hook activity, add `showSummaryOnCards` to `runtimeConfigResponseSchema` and `runtimeConfigSaveRequestSchema` |
| `src/core/api-validation.ts` | Modify | Add `conversationSummaryText` and `toolInputSummary` (pre-existing bug fix) to `parseHookIngestRequest` metadata allowlist |
| `src/commands/claude-transcript-parser.ts` | **New** | Claude Code JSONL transcript parser |
| `src/commands/hooks.ts` | Modify | Add `enrichClaudeStopMetadata`, wire into enrichment pipeline |
| `src/terminal/session-manager.ts` | Modify | Add `appendConversationSummary` method with retention policy |
| `src/terminal/agent-registry.ts` | Modify | Add `showSummaryOnCards` to `buildRuntimeConfigResponse` |
| `src/trpc/hooks-api.ts` | Modify | Call `appendConversationSummary` when summary text present in metadata |
| `src/trpc/app-router.ts` | Modify | Update `regenerateTaskTitle` to use summaries |
| `src/config/runtime-config.ts` | Modify | Add `showSummaryOnCards` setting |
| `web-ui/src/components/quarterdeck-board.tsx` | Modify | Read `showSummaryOnCards` from config, pass as prop to `BoardColumn` |
| `web-ui/src/components/board-column.tsx` | Modify | Accept and forward `showSummaryOnCards` prop to `BoardCard` |
| `web-ui/src/components/board-card.tsx` | Modify | Accept `showSummaryOnCards` prop, update tooltip, add optional card face summary |
| `web-ui/src/runtime/use-runtime-config.ts` | Modify | Add `showSummaryOnCards?: boolean` to save function's parameter type |
| `web-ui/src/components/runtime-settings-dialog.tsx` | Modify | Add toggle for card face summary |

## Success Criteria

1. **Summary capture works**: After a Claude agent session ends, `conversationSummaries` on the session summary contains at least one entry with meaningful text extracted from the transcript
2. **Retention policy enforced**: Collection never exceeds 5 entries or 2000 total chars (count limit applied first, then char cap), individual entries capped at 500 chars, first entry always retained
3. **Tooltip shows summary**: Hovering over a card with summaries shows the latest summary text (truncated to 200 chars)
4. **Trashed cards retain summaries**: Hovering over a trashed card still shows the summary tooltip
5. **Setting controls card face**: When `showSummaryOnCards` is enabled, cards show a 2-line truncated summary below the title; when disabled, no summary text on the card face
6. **Title regeneration uses summaries**: Clicking the regenerate title button includes the latest summary in the LLM context
7. **Backwards compatible**: Sessions without summaries continue to show `finalMessage` in tooltips and title regeneration
8. **No performance regression**: Transcript parsing reads only the last 50 lines; enrichment adds negligible latency to the Stop hook flow
9. **Graceful failure**: If transcript file is missing, unreadable, or format changes, enrichment silently returns null — no hook failures

**Automated verification**:
```bash
npm run check          # Lint + typecheck + tests pass
npm run test           # All runtime tests pass
npm run web:test       # All web-ui tests pass
npm run build          # Full build succeeds
```

## Future: Codex Integration

When extending summaries to Codex agents:

1. **Unified enrichment function**: Merge `enrichClaudeStopMetadata` and `enrichCodexReviewMetadata` into a single `enrichAgentMetadata` that dispatches based on `source`. Comments in `hooks.ts` show the target signature.

2. **Shared transcript parser interface**: Create a `TranscriptParser` interface (documented in `claude-transcript-parser.ts`) with per-agent implementations. The existing `extractFinalMessageFromRolloutLine` in `codex-hook-events.ts` would become the Codex implementation.

3. **Schema reuse**: The `conversationSummaries` field and retention logic are agent-agnostic — no schema changes needed for Codex.

4. **Codex differences**: Codex's `SubagentStop` event already includes `last_assistant_message` in the payload (no file parsing needed for the simple case). The transcript parsing path is a fallback for when that field is missing, which `enrichCodexReviewMetadata` already handles via `resolveCodexRolloutFinalMessageForCwd`.
