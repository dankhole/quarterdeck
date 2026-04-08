# Test Specification: Task Conversation Summaries + Title Generation

**SDD**: `docs/specs/2026-04-07-17-conversation-summaries.md`
**Date**: 2026-04-07

## Test Infrastructure

- **Framework**: Vitest
- **Runtime tests**: `test/runtime/` — direct function imports, `vi.fn()` mocking
- **Web-UI tests**: Co-located `.test.tsx` files in `web-ui/src/`
- **Patterns**: Factory helpers (`createSummary()`, `createCodexLogLine()`), `as unknown as T` for interface mocking
- **Run commands**: `npm run test` (runtime), `npm run web:test` (web-ui)

## Test Files

| Test File | Tests | Phase |
|-----------|-------|-------|
| `test/runtime/claude-transcript-parser.test.ts` | T01-T09 | Phase 2 |
| `test/runtime/hooks-claude-enrichment.test.ts` | T10-T16 | Phase 2 |
| `test/runtime/terminal/session-manager.test.ts` | T17-T22 (append to existing) | Phase 1 |
| `test/runtime/trpc/hooks-api.test.ts` | T23-T25 (append to existing) | Phase 1 |
| `test/runtime/api-validation.test.ts` | T34 (append to existing) | Phase 1 |
| `test/runtime/runtime-config.test.ts` | T35-T36 (append to existing or new) | Phase 3 |
| `web-ui/src/components/board-card.test.tsx` | T26-T30 | Phase 3 |
| `test/runtime/trpc/regenerate-title.test.ts` | T31-T33 | Phase 4 |

## Test Cases

### Claude Transcript Parser (`test/runtime/claude-transcript-parser.test.ts`)

New file. Tests the `extractLastAssistantMessage` function from `src/commands/claude-transcript-parser.ts`.

**T01: Extracts last assistant text message from valid transcript**

```typescript
it("extracts the last assistant text message from a valid transcript", async () => {
   // Write a temp JSONL file with a sequence: user → assistant (tool_use) → tool_result → assistant (text)
   // The last assistant message with meaningful text should be returned
   const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Fix the bug" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll look into that." }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } }),
      JSON.stringify({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file contents" }] }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I've fixed the bug by updating the validation logic in auth.ts. The issue was that the token expiry check was using < instead of <=, causing tokens to be rejected on their exact expiry second." }] } }),
   ];
   // Write to temp file, call extractLastAssistantMessage, expect the last assistant text
});
```

**Expected**: Returns `"I've fixed the bug by updating the validation logic in auth.ts. The issue was that the token expiry check was using < instead of <=, causing tokens to be rejected on their exact expiry second."`

---

**T02: Skips tool call acknowledgments (short text + tool_use)**

```typescript
it("skips assistant messages that are just tool call preambles", async () => {
   const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Here's what I found after investigating:" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me read that." }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } }),
   ];
   // Last line is <30 chars text + tool_use → skip it
   // Should return "Here's what I found after investigating:"
});
```

**Expected**: Returns `"Here's what I found after investigating:"` (skips the 28-char preamble with tool_use)

---

**T02b: Does NOT skip 30-char text with tool_use (boundary case)**

```typescript
it("does not skip an assistant message with exactly 30 chars of text alongside tool_use", async () => {
   const exactly30 = "A".repeat(30); // exactly 30 chars — NOT <30, so it should be kept
   const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: exactly30 }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } }),
   ];
   const result = await extractLastAssistantMessage(tempPath);
   expect(result).toBe(exactly30);
});
```

**Expected**: Returns the 30-char string. The heuristic skips messages with text `<30` chars + `tool_use`, but exactly 30 chars is NOT less than 30, so it is kept.

---

**T03: Returns null for empty or missing file**

```typescript
it("returns null when transcript file does not exist", async () => {
   const result = await extractLastAssistantMessage("/nonexistent/path.jsonl");
   expect(result).toBeNull();
});

it("returns null for an empty file", async () => {
   // Write empty temp file
   const result = await extractLastAssistantMessage(tempPath);
   expect(result).toBeNull();
});
```

---

**T04: Returns null when no meaningful assistant message exists**

```typescript
it("returns null when all assistant messages are tool acknowledgments", async () => {
   const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Do it" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Sure." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "tool_use", id: "t2", name: "Write", input: {} }] } }),
   ];
   // Both are <30 chars + tool_use → skip both → return null
});
```

---

**T05: Truncates messages exceeding 500 chars**

```typescript
it("truncates extracted text to 500 chars", async () => {
   const longText = "A".repeat(600);
   const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: longText }] } }),
   ];
   const result = await extractLastAssistantMessage(tempPath);
   expect(result).toHaveLength(501); // 500 chars + "…"
   expect(result!.endsWith("…")).toBe(true);
});
```

---

**T06: Handles malformed JSON lines gracefully**

```typescript
it("skips malformed JSON lines without failing", async () => {
   const lines = [
      "not json at all",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Valid message here." }] } }),
      "{broken json",
   ];
   const result = await extractLastAssistantMessage(tempPath);
   expect(result).toBe("Valid message here.");
});
```

---

**T07: Only reads last 50 lines of large transcripts**

```typescript
it("only processes the last 50 lines of a large transcript", async () => {
   // Write 100 lines: line 20 has a meaningful assistant message ("Early message"),
   // lines 21-99 are user messages (no assistant text messages),
   // line 80 has a meaningful assistant message ("Late message")
   // The parser reads the full file with fs.readFile then slices the last 50 lines.
   // Line 80 is within the last 50 → should be found.
   // Line 20 is outside the last 50 → should NOT be found.
   const result = await extractLastAssistantMessage(tempPath);
   expect(result).toBe("Late message");
});

it("returns null when only meaningful message is outside the 50-line window", async () => {
   // Write 100 lines: line 10 has a meaningful assistant message,
   // lines 51-100 are all user messages with no assistant text.
   // The parser slices last 50 lines (51-100), finds no assistant message → null
   const result = await extractLastAssistantMessage(tempPath);
   expect(result).toBeNull();
});
```

---

**T08: Handles assistant messages with multiple content items**

Multiple text content items are concatenated (space-separated) first, then the 500-char cap is applied to the combined result.

```typescript
it("concatenates text from multiple content items in one assistant message", async () => {
   const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
         { type: "text", text: "First part." },
         { type: "text", text: "Second part." },
      ] } }),
   ];
   const result = await extractLastAssistantMessage(tempPath);
   expect(result).toBe("First part. Second part.");
});

it("truncates after concatenating multiple content items", async () => {
   const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
         { type: "text", text: "A".repeat(300) },
         { type: "text", text: "B".repeat(300) },
      ] } }),
   ];
   const result = await extractLastAssistantMessage(tempPath);
   // Combined = 601 chars (300 + " " + 300), truncated to 500 + "…"
   expect(result).toHaveLength(501);
   expect(result!.endsWith("…")).toBe(true);
});
```

---

**T09: Ignores non-assistant message types**

```typescript
it("ignores user, tool_result, and system message types", async () => {
   const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "User text" }] } }),
      JSON.stringify({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Tool output" }] }),
      JSON.stringify({ type: "system", message: { content: "System message" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The actual summary." }] } }),
   ];
   const result = await extractLastAssistantMessage(tempPath);
   expect(result).toBe("The actual summary.");
});
```

---

### Claude Stop Enrichment (`test/runtime/hooks-claude-enrichment.test.ts`)

New file. Tests the `enrichClaudeStopMetadata` function from `src/commands/hooks.ts`.

**T10: Enriches Claude to_review event with transcript summary**

Note: In production, `source` is always `"claude"` for Claude Stop hooks because the adapter's hook config passes `--source claude` as an explicit CLI flag (`agent-session-adapters.ts:514`). This test uses the explicit source value directly — testing `inferHookSourceFromPayload` is separate from enrichment behavior.

```typescript
it("enriches Claude to_review metadata with conversation summary from transcript", async () => {
   // Mock: write a transcript file with last assistant message text = "Fixed the auth bug in token validation"
   // Input: HooksIngestArgs with source="claude", event="to_review", payload.transcript_path=tempPath,
   //        metadata.finalMessage not set (undefined/null)
   const result = await enrichClaudeStopMetadata(args);
   expect(result.metadata?.conversationSummaryText).toBe("Fixed the auth bug in token validation");
   expect(result.metadata?.finalMessage).toBe("Fixed the auth bug in token validation");
   expect(result.metadata?.activityText).toBe("Final: Fixed the auth bug in token validation");
});
```

---

**T11: No-ops for non-Claude sources**

```typescript
it("returns args unchanged when source is not claude", async () => {
   const args = createHooksIngestArgs({ event: "to_review", source: "codex" });
   const result = await enrichClaudeStopMetadata(args);
   expect(result).toBe(args); // Reference equality — unchanged
});
```

---

**T12: No-ops for non-to_review events**

```typescript
it("returns args unchanged for activity events", async () => {
   const args = createHooksIngestArgs({ event: "activity", source: "claude" });
   const result = await enrichClaudeStopMetadata(args);
   expect(result).toBe(args);
});
```

---

**T13: Does not overwrite existing finalMessage**

```typescript
it("does not overwrite finalMessage if already set", async () => {
   // Input: args with metadata.finalMessage already set (e.g. from SubagentStop)
   // Expect: conversationSummaryText is set from transcript, but finalMessage stays unchanged
});
```

---

**T14: Handles missing transcript_path gracefully**

```typescript
it("returns args unchanged when payload has no transcript_path", async () => {
   const args = createHooksIngestArgs({ event: "to_review", source: "claude", payload: {} });
   const result = await enrichClaudeStopMetadata(args);
   expect(result).toBe(args);
});
```

---

**T15: Handles unreadable transcript file gracefully**

```typescript
it("returns args unchanged when transcript file cannot be read", async () => {
   const args = createHooksIngestArgs({
      event: "to_review",
      source: "claude",
      payload: { transcript_path: "/nonexistent/file.jsonl" },
   });
   const result = await enrichClaudeStopMetadata(args);
   // conversationSummaryText should remain null, no error thrown
   expect(result.metadata?.conversationSummaryText).toBeUndefined();
});
```

---

**T16: Checks both transcript_path and transcriptPath payload keys**

```typescript
it("reads transcriptPath (camelCase) from payload when transcript_path is absent", async () => {
   // Write transcript, pass payload with { transcriptPath: tempPath } (no underscore)
   // Expect: summary extracted successfully
});
```

---

### Session Manager — Summary Retention (`test/runtime/terminal/session-manager.test.ts`)

Append to existing file. Tests `appendConversationSummary` method.

**T17: Appends first summary entry**

```typescript
it("appends the first conversation summary entry", () => {
   const manager = new TerminalSessionManager();
   manager.hydrateFromRecord({ "task-1": createSummary({ state: "running" }) });

   const updated = manager.appendConversationSummary("task-1", {
      text: "Fixed the auth bug",
      capturedAt: Date.now(),
   });

   expect(updated?.conversationSummaries).toHaveLength(1);
   expect(updated?.conversationSummaries[0].text).toBe("Fixed the auth bug");
   expect(updated?.conversationSummaries[0].sessionIndex).toBe(0); // auto-assigned
});
```

---

**T18: Retains first entry when collection grows past max count**

```typescript
it("always retains the first summary entry and enforces max 5 entries", () => {
   // Add 7 entries sequentially
   // Verify the first entry (sessionIndex 0) is always present
   // Verify the latest entry is always present
   // Verify total entries <= 5 (count limit)
   // Verify oldest non-first entries were dropped
});
```

---

**T19: Enforces 2000 char total cap**

```typescript
it("drops oldest non-first entries when total chars exceed 2000", () => {
   // Add entries with ~500 chars each
   // After 5th entry (2500 chars), the oldest non-first entry should be dropped
   // Verify total text length <= 2000
});
```

---

**T19b: Count prune and char cap interact correctly with varying entry sizes**

```typescript
it("applies count prune first then char cap on survivors", () => {
   // Add 6 entries: entry 0 = 100 chars, entries 1-4 = 450 chars each, entry 5 = 450 chars
   // After count prune (max 5): entry 0 retained (first), entry 1 dropped (oldest non-first), entries 2-5 survive
   // Total after count prune: 100 + 450*4 = 1900 chars → under 2000 → no char prune needed
   // Verify 5 entries remain: [0, 2, 3, 4, 5]
   //
   // Then add entry 6 = 450 chars → count prune drops entry 2 → survivors: [0, 3, 4, 5, 6]
   // Total: 100 + 450*4 = 1900 → still under 2000 → no char prune
   //
   // Then add entry 7 = 500 chars → count prune drops entry 3 → survivors: [0, 4, 5, 6, 7]
   // Total: 100 + 450*2 + 450 + 500 = 1950 → under 2000 → no char prune
   // Verify order and content of retained entries
});
```

---

**T20: Truncates individual entries exceeding 500 chars**

```typescript
it("truncates entry text to 500 chars before storing", () => {
   const manager = new TerminalSessionManager();
   manager.hydrateFromRecord({ "task-1": createSummary({ state: "running" }) });

   const updated = manager.appendConversationSummary("task-1", {
      text: "X".repeat(600),
      capturedAt: Date.now(),
   });

   expect(updated?.conversationSummaries[0].text).toHaveLength(501); // 500 + "…"
});
```

---

**T21: Returns null for unknown task ID**

```typescript
it("returns null when task ID does not exist", () => {
   const manager = new TerminalSessionManager();
   const result = manager.appendConversationSummary("unknown-task", {
      text: "Summary",
      capturedAt: Date.now(),
   });
   expect(result).toBeNull();
});
```

---

**T22: Auto-assigns monotonically increasing sessionIndex**

```typescript
it("auto-assigns monotonically increasing sessionIndex values", () => {
   const manager = new TerminalSessionManager();
   manager.hydrateFromRecord({ "task-1": createSummary({ state: "running" }) });

   // Append 3 entries — method only takes { text, capturedAt }, assigns sessionIndex internally
   manager.appendConversationSummary("task-1", { text: "First", capturedAt: 1000 });
   manager.appendConversationSummary("task-1", { text: "Second", capturedAt: 2000 });
   const updated = manager.appendConversationSummary("task-1", { text: "Third", capturedAt: 3000 });

   expect(updated?.conversationSummaries.map(s => s.sessionIndex)).toEqual([0, 1, 2]);
});
```

---

### Hooks API — Summary Flow (`test/runtime/trpc/hooks-api.test.ts`)

Append to existing file.

**Phase dependency**: T23-T25 require the `conversationSummaryText` field on `runtimeTaskHookActivitySchema` from Phase 1.1 and the `appendConversationSummary` method from Phase 1.2. These tests should be implemented after Phase 1 is complete.

**T23: Calls appendConversationSummary when conversationSummaryText is present**

```typescript
it("calls appendConversationSummary when metadata includes conversationSummaryText", async () => {
   const manager = {
      getSummary: vi.fn(() => createSummary({ state: "running" })),
      transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review" })),
      transitionToRunning: vi.fn(),
      applyHookActivity: vi.fn(),
      applyTurnCheckpoint: vi.fn(),
      appendConversationSummary: vi.fn(),
   } as unknown as TerminalSessionManager;

   // Call ingest with metadata containing conversationSummaryText
   // Verify appendConversationSummary was called with correct taskId and entry
});
```

---

**T24: Does not call appendConversationSummary when text is null**

```typescript
it("does not call appendConversationSummary when conversationSummaryText is null", async () => {
   // Call ingest with metadata without conversationSummaryText
   // Verify appendConversationSummary was NOT called
});
```

---

**T25: Summary appended before broadcast**

```typescript
it("appends summary after applyHookActivity and before broadcast", async () => {
   // Verify the call order: applyHookActivity → appendConversationSummary → broadcastRuntimeWorkspaceStateUpdated
   // This ensures the WebSocket broadcast includes the newly appended summary
});
```

---

### Board Card UI (`web-ui/src/components/board-card.test.tsx`)

New file or append to existing if one exists. Tests tooltip and card face summary display.

**Prerequisite**: `getCardHoverTooltip` must be exported from `board-card.tsx` (it is currently module-scoped). Add `export` to the function declaration — it is pure logic with no side effects, making it safe and simple to test directly.

**T26: Tooltip shows latest conversation summary**

```typescript
it("shows the latest conversation summary in card tooltip", () => {
   const summary = createSummary({
      state: "awaiting_review",
      conversationSummaries: [
         { text: "First session work", capturedAt: 1000, sessionIndex: 0 },
         { text: "Fixed the auth validation bug in token expiry check", capturedAt: 2000, sessionIndex: 1 },
      ],
   });
   const tooltip = getCardHoverTooltip(summary);
   expect(tooltip).toBe("Fixed the auth validation bug in token expiry check");
});
```

---

**T27: Tooltip falls back to finalMessage when no summaries**

```typescript
it("falls back to finalMessage when conversationSummaries is empty", () => {
   const summary = createSummary({
      state: "awaiting_review",
      conversationSummaries: [],
      latestHookActivity: { finalMessage: "Task complete" },
   });
   const tooltip = getCardHoverTooltip(summary);
   expect(tooltip).toBe("Task complete");
});
```

---

**T28: Tooltip truncates long summaries to 200 chars**

```typescript
it("truncates tooltip text to 200 chars with ellipsis", () => {
   const longText = "A".repeat(250);
   const summary = createSummary({
      state: "awaiting_review",
      conversationSummaries: [{ text: longText, capturedAt: 1000, sessionIndex: 0 }],
   });
   const tooltip = getCardHoverTooltip(summary);
   expect(tooltip).toHaveLength(201); // 200 + "…"
});
```

---

**T29: Trashed card still shows tooltip from summary**

```typescript
it("shows summary tooltip on trashed cards", () => {
   // Render a card in the trash column with conversationSummaries
   // Verify tooltip content is present (summaries persist on trashed cards)
});
```

---

**T30: Card face summary respects global setting (via prop)**

```typescript
it("shows summary text on card face only when showSummaryOnCards prop is true", () => {
   // Render BoardCard with showSummaryOnCards={true} and a session with conversationSummaries
   // Verify: summary text element is rendered with line-clamp-2 class
   // Verify: text is truncated to 150 chars

   // Re-render BoardCard with showSummaryOnCards={false} and same session
   // Verify: no summary text element is rendered
});
```

---

### Title Regeneration (`test/runtime/trpc/regenerate-title.test.ts`)

New file. Tests the updated `regenerateTaskTitle` mutation.

**T31: Uses conversation summary as context for title generation**

```typescript
it("passes latest conversation summary to generateTaskTitle", async () => {
   // Mock workspace state with a card that has conversationSummaries
   // Mock generateTaskTitle to capture the context argument
   // Verify context includes "Agent summary: {latest summary text}"
});
```

---

**T32: Falls back to finalMessage when no summaries**

```typescript
it("falls back to finalMessage when no conversation summaries exist", async () => {
   // Mock workspace state with a card that has finalMessage but no summaries
   // The SDD changes the label to "Agent summary:" for BOTH paths (summary and finalMessage fallback)
   // Verify context includes "Agent summary: {finalMessage}" (NOT "Agent response:")
});
```

---

**T33: Uses only prompt when no summary or finalMessage**

```typescript
it("uses only the prompt when no agent context is available", async () => {
   // Mock workspace state with a card that has no summaries and no finalMessage
   // Verify context is just the card.prompt
});
```

---

### API Validation — Metadata Passthrough (`test/runtime/api-validation.test.ts`)

Append to existing file. Tests that `parseHookIngestRequest` preserves the new field.

**T34: parseHookIngestRequest preserves conversationSummaryText and toolInputSummary**

Note: `toolInputSummary` was already on the schema but missing from the allowlist (pre-existing bug). This test covers both the new field and the bug fix.

```typescript
it("preserves conversationSummaryText in parsed metadata", () => {
   const raw = {
      event: "to_review",
      taskId: "task-1",
      workspaceId: "ws-1",
      metadata: {
         source: "claude",
         conversationSummaryText: "Fixed the auth bug by updating token validation",
         finalMessage: "Done",
      },
   };
   const parsed = parseHookIngestRequest(raw);
   expect(parsed.metadata?.conversationSummaryText).toBe("Fixed the auth bug by updating token validation");
});

it("trims whitespace from conversationSummaryText", () => {
   const raw = {
      event: "to_review",
      taskId: "task-1",
      workspaceId: "ws-1",
      metadata: {
         source: "claude",
         conversationSummaryText: "  Summary with whitespace  ",
      },
   };
   const parsed = parseHookIngestRequest(raw);
   expect(parsed.metadata?.conversationSummaryText).toBe("Summary with whitespace");
});

it("normalizes whitespace-only conversationSummaryText to null", () => {
   const raw = {
      event: "to_review",
      taskId: "task-1",
      workspaceId: "ws-1",
      metadata: {
         source: "claude",
         conversationSummaryText: "   ",
      },
   };
   const parsed = parseHookIngestRequest(raw);
   expect(parsed.metadata?.conversationSummaryText).toBeNull();
});

it("preserves toolInputSummary in parsed metadata (pre-existing bug fix)", () => {
   const raw = {
      event: "activity",
      taskId: "task-1",
      workspaceId: "ws-1",
      metadata: {
         source: "claude",
         toolName: "Read",
         toolInputSummary: "src/index.ts",
      },
   };
   const parsed = parseHookIngestRequest(raw);
   expect(parsed.metadata?.toolInputSummary).toBe("src/index.ts");
});
```

---

### Runtime Config — showSummaryOnCards (`test/runtime/runtime-config.test.ts`)

Append to existing file or create new. Tests config persistence and default value.

**T35: showSummaryOnCards defaults to false**

```typescript
it("defaults showSummaryOnCards to false when not set in config file", () => {
   // Load config from a file that does not contain showSummaryOnCards
   // Verify the resulting RuntimeConfigState has showSummaryOnCards === false
});
```

---

**T36: showSummaryOnCards round-trips through save and load**

```typescript
it("persists showSummaryOnCards through save and load cycle", async () => {
   // Save config with showSummaryOnCards: true
   // Load config
   // Verify showSummaryOnCards === true
   // Save config with showSummaryOnCards: false
   // Load config
   // Verify showSummaryOnCards === false
});
```

---

## Traceability Matrix

| SDD Requirement | Test Cases |
|----------------|------------|
| Transcript parsing extracts last meaningful assistant message | T01, T02, T08, T09 |
| Skips tool call acknowledgments (<30 chars + tool_use) | T02, T02b, T04 |
| Returns null on errors (missing file, parse errors) | T03, T06 |
| Caps individual entries at 500 chars | T05, T08, T20 |
| Only reads last 50 lines (fs.readFile + slice) | T07 |
| CLI enrichment for Claude to_review events | T10 |
| No-op for non-Claude sources | T11 |
| No-op for non-to_review events | T12 |
| Does not overwrite existing finalMessage | T13 |
| Graceful handling of missing/unreadable transcript | T14, T15 |
| Supports both transcript_path and transcriptPath keys | T16 |
| Summary storage with appendConversationSummary | T17 |
| Retention: always keeps first entry | T18 |
| Retention: max 5 entries (count limit first) then 2000 char cap | T18, T19, T19b |
| Individual entry truncation | T20 |
| Returns null for unknown task | T21 |
| Auto-assigned monotonic sessionIndex | T22 |
| hooks-api calls appendConversationSummary before broadcast | T23, T25 |
| hooks-api skips when no summary text | T24 |
| Tooltip prefers summary over finalMessage | T26, T27 |
| Tooltip truncates to 200 chars | T28 |
| Trashed cards retain summary tooltips | T29 |
| Card face setting controls display (prop-based) | T30 |
| Card face latestSummaryText truncated to 150 chars | T30 |
| Title regeneration uses summaries | T31 |
| Title regeneration falls back to finalMessage | T32 |
| Title regeneration uses prompt-only when no context | T33 |
| parseHookIngestRequest preserves conversationSummaryText | T34 |
| parseHookIngestRequest preserves toolInputSummary (pre-existing bug fix) | T34 |
| showSummaryOnCards config default and round-trip | T35, T36 |
| Backwards compatible (no summaries → existing behavior) | T27, T32, T33 |
| Whitespace-only conversationSummaryText normalized to null | T34 |
| Error isolation: enrichment crash does not block hook ingest | T15 |
| Graceful failure (never throws) | T03, T06, T14, T15, T21 |

## Test Commands

```bash
# Run all runtime tests (includes new test files)
npm run test

# Run only the new/modified test files
npx vitest test/runtime/claude-transcript-parser.test.ts
npx vitest test/runtime/hooks-claude-enrichment.test.ts
npx vitest test/runtime/terminal/session-manager.test.ts
npx vitest test/runtime/trpc/hooks-api.test.ts
npx vitest test/runtime/api-validation.test.ts
npx vitest test/runtime/runtime-config.test.ts

# Run web-ui tests
npm run web:test

# Run everything
npm run check
```
