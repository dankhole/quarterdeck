# Research: Task Conversation Summary — Transcript Parsing vs Prompt-Based Summarization

**Date**: 2026-04-06
**Branch**: feat/terminal-clear-restart

## Research Question

When an agent transitions a task (e.g., `to_review`), how can quarterdeck capture a lightweight conversation summary? Two approaches: (1) parse the Claude Code transcript JSONL file from the hook's stdin, or (2) use a Claude Code prompt-based hook to generate a summary via LLM call. What does each approach require and how does it fit into the existing hook infrastructure?

## Summary

**Approach 1 (transcript parsing)** is mechanically simple — Claude Code already passes `transcript_path` in the hook stdin JSON, and the existing `normalizeHookMetadata` already extracts fields like `last_assistant_message` from that payload. The hook command would need a small wrapper script (or inline shell) to read the JSONL, extract the last assistant message, and forward it as a `--final-message` or new `--summary` flag. However, the transcript JSONL contains raw conversation turns, not a summary — so "last assistant message" may be a tool call acknowledgment rather than a meaningful recap.

**Approach 2 (prompt-based hook)** produces better summaries since it asks the LLM to synthesize. Claude Code supports prompt hooks natively — the `type` field in the hook config can be `"prompt"` instead of `"command"`, and the LLM call sees the full conversation context. However, this adds latency (a model call on every Stop event) and cost (tokens consumed per transition). It also couples the summary quality to prompt engineering.

**The existing infrastructure already handles `finalMessage` extraction from `SubagentStop` hooks** (`last_assistant_message` field) and from Codex session logs. For Claude Code `Stop` hooks specifically, the stdin payload does NOT include `last_assistant_message` — only `transcript_path`, `stop_reason`, `session_id`, and `hook_event_name`. So transcript parsing is needed if we want the agent's final words.

## Detailed Findings

### How Claude Code Hooks Currently Work in Quarterdeck

The Claude adapter configures hooks via a dynamically generated `settings.json` written to `~/.quarterdeck/agents/claude/settings.json` before each session launch:

**`src/terminal/agent-session-adapters.ts:509-560`**

```
Stop        -> quarterdeck hooks ingest --event to_review --source claude
SubagentStop -> quarterdeck hooks ingest --event activity --source claude
PreToolUse   -> quarterdeck hooks ingest --event activity --source claude
PostToolUse  -> quarterdeck hooks ingest --event to_in_progress --source claude
PermissionRequest -> quarterdeck hooks ingest --event to_review --source claude
Notification -> quarterdeck hooks ingest --event to_review --source claude (permission_prompt)
              -> quarterdeck hooks ingest --event activity --source claude (other)
UserPromptSubmit -> quarterdeck hooks ingest --event to_in_progress --source claude
```

All hooks are `type: "command"`. The hook command is built by `buildHookCommand()` (`agent-session-adapters.ts:89-104`) which constructs a shell command string with `--event` and `--source` flags.

**Critical detail**: Claude Code pipes the hook event's JSON payload to the command's **stdin**. The `readStdinText()` function (`hooks.ts:519-529`) reads it, and `parseHooksIngestArgs()` (`hooks.ts:371-391`) parses it as a JSON payload. So the full hook event context is already available to the quarterdeck hook handler.

### What Claude Code's Stop Hook Sends via stdin

Based on Claude Code hook documentation, the `Stop` event provides:

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../sessions/abc123.jsonl",
  "cwd": "/path/to/worktree",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_reason": "end_turn"
}
```

**No `last_assistant_message` field.** The `SubagentStop` event does include `last_assistant_message`, but the top-level `Stop` does not. This means the existing `normalizeHookMetadata` (`hooks.ts:343-349`) which looks for `last_assistant_message` won't find anything on a `Stop` event.

### Approach 1: Transcript Parsing

**What exists today**: The `transcript_path` field points to a JSONL file containing the full conversation. Each line is a JSON object representing a conversation turn (user message, assistant message, tool use, tool result, etc.).

**What would need to change**:

1. **Hook command becomes a script** instead of a direct `quarterdeck hooks ingest` call. The script would:
   - Read stdin JSON to get `transcript_path`
   - Parse the JSONL to extract the last assistant text message (skipping tool calls)
   - Call `quarterdeck hooks ingest --event to_review --source claude --final-message "extracted text"`

2. **Or, handle it server-side**: Pass `transcript_path` through as metadata, and have `hooks-api.ts` read the file on the runtime side. Simpler hook config, but the runtime now reads agent-owned files.

3. **Or, inline it**: Replace the simple command string with a shell pipeline:
   ```sh
   cat /dev/stdin | jq -r '.transcript_path' | xargs -I{} tail -20 {} | jq -r 'select(.role=="assistant") | .content' | tail -1 | xargs -I{} quarterdeck hooks ingest --event to_review --source claude --final-message "{}"
   ```
   Fragile and hard to maintain.

**Pros**:
- Zero additional API/model calls
- No latency beyond file I/O
- Deterministic — always extracts the same content

**Cons**:
- Last assistant message may not be a good summary (could be "Done!", a tool acknowledgment, or a long explanation)
- Requires understanding the JSONL format, which is Claude Code internal and could change
- Shell scripting complexity if done in the hook command
- Transcript file access from the runtime side crosses process boundaries

### Approach 2: Prompt-Based Hook

**What Claude Code supports**: Hook configs can use `type: "prompt"` instead of `type: "command"`. A prompt hook runs a lightweight LLM call with the conversation context and a user-defined prompt. The LLM's response is available as structured output.

**What would need to change**:

1. **Replace the Stop hook** (or add a second hook) with a prompt-based hook:
   ```json
   {
     "type": "prompt",
     "prompt": "In 1-2 sentences, summarize what you accomplished on this task. Focus on what changed and why."
   }
   ```

2. **Capture the output**: Prompt hooks return the LLM's response. This would need to be piped to a command hook that calls `quarterdeck hooks ingest --summary "..."`. Claude Code hook chains support this — you can have multiple hooks in a single event, executed in order.

3. **Or, combine**: Use a prompt hook that generates the summary, followed by a command hook that ingests it. The prompt hook's output is injected into Claude's context, not directly pipeable to a command. This is a limitation — prompt hooks influence the agent's behavior, they don't produce side-channel output.

**Actually**: After deeper investigation, prompt hooks are designed for injecting guidance into the agent's context, not for producing extractable output. A prompt hook on `Stop` would ask the LLM to respond with a summary, but that response goes into the conversation — it doesn't get piped to a shell command. This makes approach 2 unsuitable for direct integration unless we add a two-step process:
   - Step 1: Prompt hook generates summary (goes into conversation)
   - Step 2: The summary appears in the transcript, which a subsequent command hook could parse

This is circular and fragile.

**Actual viable variant**: Instead of a prompt hook, use a command hook that spawns a lightweight API call itself (e.g., `curl` to Claude API with the last N messages from the transcript). But this is essentially approach 1 + an API call, not a native prompt hook.

**Pros**:
- Higher quality summaries — LLM synthesizes, not just extracts
- Could be agent-agnostic if implemented as a separate API call

**Cons**:
- Prompt hooks don't produce side-channel output — they inject into conversation context
- Would need a workaround (API call in command hook) to actually extract the summary
- Adds latency (model call per transition)
- Adds cost (tokens per transition)
- Requires API key management in the hook script
- More moving parts and failure modes

### Approach 1b: Hybrid — Last Message Extraction (Already Almost Free)

There's actually a simpler variant of approach 1 that's nearly zero-effort:

**The `SubagentStop` event already includes `last_assistant_message`**. For task agents that use subagents (which is common), this message is already extracted by `normalizeHookMetadata` (`hooks.ts:344`) and stored as `finalMessage` on `latestHookActivity`.

For the top-level `Stop` event, quarterdeck could read the transcript file server-side (the path is in the payload) and extract the last assistant message. This keeps the hook command simple and moves the parsing to Go/Node where it's more maintainable.

**What exists for reference**: The Codex adapter already does something similar — `enrichCodexReviewMetadata` (`hooks.ts:460-500`) reads Codex session logs to extract a final message when one isn't provided in the hook event. The same pattern could be applied to Claude's transcript.

## Code References

- `src/terminal/agent-session-adapters.ts:89-104` — `buildHookCommand()` constructs the shell command for Claude hooks
- `src/terminal/agent-session-adapters.ts:509-560` — Claude adapter hook configuration (all `type: "command"`)
- `src/commands/hooks.ts:317-369` — `normalizeHookMetadata()` extracts `last_assistant_message`, `tool_name`, etc. from stdin payload
- `src/commands/hooks.ts:343-349` — Where `finalMessage` is extracted from payload fields including `last_assistant_message`
- `src/commands/hooks.ts:460-500` — `enrichCodexReviewMetadata()` — existing pattern for enriching hook data from agent session files
- `src/commands/hooks.ts:519-529` — `readStdinText()` reads stdin JSON from Claude Code
- `src/commands/hooks.ts:371-391` — `parseHooksIngestArgs()` merges stdin payload with CLI flags
- `src/commands/hooks.ts:226-301` — `inferActivityText()` builds human-readable activity labels
- `src/terminal/hook-runtime-context.ts:17-22` — `createHookRuntimeEnv()` sets `QUARTERDECK_HOOK_TASK_ID` and `QUARTERDECK_HOOK_WORKSPACE_ID`
- `src/trpc/hooks-api.ts:44-126` — Server-side hook ingestion handler

## Architecture & Patterns

**Existing enrichment pattern**: The codebase already has a precedent for enriching hook metadata from agent-specific files. `enrichCodexReviewMetadata()` reads Codex session logs to extract a final message when the hook event doesn't include one. The same pattern applies naturally to reading Claude's transcript JSONL.

**Metadata flow**: CLI flags > base64 metadata > stdin JSON > positional arg. All merge into a single `Partial<RuntimeTaskHookActivity>` before being applied to the session summary.

**Hook command construction**: `buildHookCommand()` generates a simple shell command string. It does not currently support wrapping in a script or multi-step pipelines. Adding transcript parsing would require either changing the hook command to a script path or handling it server-side.

## Recommendation

**Approach 1b (server-side transcript parsing)** is the strongest fit:

1. Pass `transcript_path` through from the stdin payload to the server (it's already read and available)
2. On the server side (in `hooks-api.ts` or a new enrichment function like `enrichClaudeReviewMetadata`), read the last assistant message from the JSONL
3. Store it as a new `summary` or reuse `finalMessage` on the session summary
4. This mirrors the existing `enrichCodexReviewMetadata` pattern exactly

This avoids shell scripting complexity, keeps hook commands simple, adds zero latency from model calls, and follows an established codebase pattern.

## Open Questions

- What's the exact JSONL format of Claude Code transcripts? Need to verify the schema for extracting the last assistant text message (vs tool calls, reasoning, etc.).
- Should the summary field be separate from `finalMessage` to preserve both the short status and the longer recap?
- Should this work for non-Claude agents too? Codex already has `enrichCodexReviewMetadata` — would we unify these into a single `enrichReviewMetadata` function?
- Size limits: should the summary be capped (e.g., 500 chars) to prevent bloating session state?
