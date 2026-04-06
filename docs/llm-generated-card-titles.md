# LLM-Generated Card Titles

## Context

As of the card redesign (feature/card-redesign branch), cards now have a `title: string | null` field on `runtimeBoardCardSchema`. When `title` is null, the UI falls back to `truncateTaskPromptLabel(card.prompt)` — the first ~100 chars of the raw prompt. This works but produces poor titles when the user types something casual or verbose (e.g. "I dont like that a done terminal and a terminal awaiting input are both green for review...").

The goal is to auto-generate a short (3-8 word) task title via an LLM call, so cards are scannable at a glance.

## Current State

### Schema (already implemented)
- `title` field exists on `runtimeBoardCardSchema` in `src/core/api-contract.ts`
- `RuntimeCreateTaskInput` and `RuntimeUpdateTaskInput` both accept `title`
- `addTaskToColumn()` and `updateTask()` in `src/core/task-board-mutations.ts` wire it through
- Frontend `BoardCard` interface in `web-ui/src/types/board.ts` has `title: string | null`
- UI renders `card.title || truncateTaskPromptLabel(card.prompt)` in `board-card.tsx`

### What's NOT implemented yet
- No LLM call to generate titles
- No UI to manually edit or regenerate a title
- No tRPC mutation for title-only updates (would need to go through `updateTask`)

## Design Decisions Needed

### 1. Which API key / provider to use?

The runtime currently has **no direct LLM API client**. Agents run as spawned PTY processes with their own credentials.

**Options:**
- **Environment variable**: Use `ANTHROPIC_API_KEY` from env with raw `fetch()` to Anthropic API. Simplest, zero dependencies. Downside: only works for users with Anthropic keys, not OpenAI/etc.
- **User's configured agent provider**: Would need to build a lightweight provider abstraction that reads from whatever config the agents use. More work but covers more users.
- **Dedicated lightweight config**: Add a "title generation" setting in kanban config where user picks a model/key specifically for utility tasks. Most flexible but adds config surface.
- **Ask the agent itself**: Instead of a separate LLM call, inject a system prompt instruction telling the agent to emit a short title via a hook event after it understands the task. Zero API cost but depends on agent cooperation and hook plumbing.

**Recommendation**: Start with `ANTHROPIC_API_KEY` from env + raw `fetch()`. It's the simplest path and Anthropic's cheapest model (Haiku) is ideal for this. Can expand to other providers later. Gracefully fall back to truncated prompt if no key is available.

### 2. When to trigger title generation?

**Options:**
- **On card creation**: Generate from the prompt text alone. Immediate but the prompt might be vague — an LLM can still do better than truncation though.
- **After first meaningful agent activity**: Wait for the first hook event or tool call, then generate from prompt + early activity context. Better titles but delayed.
- **After agent completes (process.exit)**: Generate from prompt + final message. Best context but title arrives late — card has no good title while running.
- **Two-pass**: Generate immediately from prompt on create, then update after agent completes with richer context.

**Recommendation**: Generate on card creation from the prompt alone. It's fast, doesn't block on agent activity, and the prompt usually contains enough intent for a reasonable title. The user can regenerate later if needed.

### 3. How to let users edit / regenerate?

**Options:**
- **Inline edit**: Click the title on the card or in the detail panel to edit it directly.
- **Regenerate button**: Small refresh icon on hover that re-triggers the LLM call (useful after the agent has done more work and the task scope has evolved).
- **Right-click context menu**: "Rename" or "Regenerate title" option.
- **Detail panel action**: Button in the task detail sidebar.

**Recommendation**: Both inline edit (click-to-edit in the detail panel) and a regenerate action. Inline edit is essential for manual control. Regenerate is a convenience for when you want the LLM to take another pass with more context.

### 4. Cost / rate concerns

- Haiku is ~$0.25/MTok input, $1.25/MTok output. A title generation call is ~200 input tokens + ~20 output tokens = ~$0.00007 per call. Negligible.
- Should still debounce/deduplicate: don't regenerate if a title already exists unless explicitly requested.
- If no API key is available, silently fall back to truncated prompt — never error or block task creation.

## Implementation Sketch

### Runtime side

1. **New module**: `src/title/title-generator.ts`
   - `generateTaskTitle(prompt: string): Promise<string | null>`
   - Uses `fetch()` to Anthropic messages API with Haiku
   - System prompt: "Generate a concise 3-8 word title for this coding task. Return only the title, nothing else."
   - Returns null on any failure (no key, network error, bad response)
   - Reads `ANTHROPIC_API_KEY` from `process.env`

2. **Hook into card creation**: In the tRPC `runtime.createCard` handler (or the session manager), after creating the card, fire-and-forget `generateTaskTitle(prompt)` and update the card title via `updateTask` when it resolves.

3. **tRPC mutation for regeneration**: Add `runtime.regenerateTaskTitle` that takes `taskId`, reads the card's prompt (+ optionally the latest finalMessage for richer context), calls `generateTaskTitle`, and updates the card.

### Frontend side

1. **Detail panel**: Add click-to-edit on the task title. Save via existing `updateTask` tRPC mutation with `title` field.
2. **Regenerate button**: In the detail panel header, a small refresh icon that calls `runtime.regenerateTaskTitle`.
3. **Optimistic update**: Show "Generating..." placeholder while the LLM call is in flight.

### Key files to modify
- `src/title/title-generator.ts` — new, LLM call logic
- `src/trpc/runtime-router.ts` — hook into createCard, add regenerateTaskTitle mutation
- `web-ui/src/components/detail-panels/` — inline title editing + regenerate button
- `web-ui/src/components/board-card.tsx` — may need minor tweaks for loading state

## Open Questions

- Should we support OpenAI / other providers from the start, or just Anthropic initially?
- Should the "ask the agent" approach (via system prompt + hook) be explored as an alternative to a separate LLM call? It's zero cost but harder to control.
- Should title generation be opt-in (config flag) or on-by-default with graceful fallback?
- When regenerating, should we include the agent's `finalMessage` as additional context, or just the original prompt?
