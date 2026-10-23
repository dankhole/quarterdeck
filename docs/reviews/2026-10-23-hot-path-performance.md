# Hot-path performance audit (2026-10-23)

> Historical audit of the baseline below, not current instructions or an active backlog. Findings may have been resolved since this review; revalidate against current code before acting. Remaining work is tracked in the primary checkout's local Chit list.

Baseline: `27293863` plus the uncommitted Pi background-subagent and Pi HTTP-hook changes. Read-only review across Claude Code, Codex, and Pi hook delivery, runtime ingest and persistence, terminal pipeline, timers/pollers, and web-ui hot paths. Evidence came from the live diagnostics journal (read-only; 1,993 records over ~2h, 1,100 `hook.received` in 21 minutes, peak 137/min), real state files under `~/.quarterdeck/projects`, and tsx micro-benchmarks against a copy of a real `sessions.json`. Prior fixes used as patterns: `f1e3ba1a`, `f2798402`, `186e68cc`, `e4f9d48b`, `799baf56`, `27293863`.

Already addressed in the same change set: Pi best-effort tool activity hooks no longer spawn a `hooks notify` process per event; they POST in-process to the loopback notify endpoint.

## Findings

### HP-1 — High (confirmed): reliable tool hooks spawn a process and force a full session write while the provider waits

- **Claude:** `src/claude-hooks.ts` sends only `activity` hooks over HTTP; PreToolUse, PostToolUse, PostToolUseFailure, and UserPromptSubmit are reliable `hooks ingest` commands. Pre/PostToolUse are ~70% of live hooks.
- **Codex:** `src/codex-hooks.ts` spawns `notify` for PreToolUse and reliable `ingest` for PostToolUse and UserPromptSubmit: two Node spawns per tool call.
- **Cost per reliable hook:** ~50 ms `hooks.js` startup, an outbox write and removal (`src/hook-transition-outbox-core.ts`), an HTTP POST, and a server-side durability barrier before acknowledgement. Claude and Codex block the tool (PreToolUse) or continuation (PostToolUse) on the hook.
- **Forced write:** in `src/trpc/hooks-api.ts` `completeHookIngest`, `observedSessionChanges.changed()` is true for every accepted hook because `commitHookEventOrder` appends an order receipt (`store.recordProviderHookReceipt`) and `latestHookActivity` changes. Running→Running tool hooks therefore force `persistRuntimeSessions`. `f2798402` only skipped forced writes for duplicate/rejected deliveries.
- **Direction:** force the durability barrier only for semantic state or outstanding-interaction changes, and let receipt/activity-only updates ride the debounced writer. Separately decide whether Claude Pre/PostToolUse may use HTTP while the task is already Running, keeping command + outbox for transitions out of Review (PermissionRequest, Stop, UserPromptSubmit, elicitation). The transport change is a reliability tradeoff that needs an explicit decision.

### HP-2 — High (confirmed): `sessions.json` is dominated by hook-order receipts and fully rewritten on every change

- The quarterdeck project's `sessions.json` was 2.19 MB for 13 tasks; 1.66 MB was `recentProviderHookOrderObservations` (cap 512 per task, ~520 B each, `src/terminal/session-summary-store.ts`). Other projects: 451–664 KB for 3+ tasks, against 1–13 KB `board.json` files. Idle Review tasks keep 90–512 receipts, nearly all completed Pre/PostToolUse pairs, each repeating `sessionInstanceId` and `providerSessionId`.
- Each persist (100 ms trailing debounce plus HP-1 barriers) reads the index, takes the project lock, reads `meta.json`/`board.json`, zod-parses all sessions (2.9 ms), pretty-prints (3.1 ms), reads the existing file to compare in `writeTextFileAtomic` (`src/fs/locked-file-system.ts`), then writes and renames. ~12–15 ms per persist, ~6 ms synchronous; with two writes per tool call that is ~4.4 MB read plus ~4.4 MB written per tool call in that project. Browser payloads already strip receipts (`src/server/runtime-state-messages.ts`).
- **Direction:** compact receipts (drop per-entry session ids, prune completed tool pairs, cap at ~64–128) or move them out of the hot rewrite; drop the compare-read and pretty-printing for `sessions.json`.

### HP-3 — Medium-high (confirmed): progress preview writes a presentation field through the durable store every second

- `src/server/task-progress-preview.ts` polls every second (`PROGRESS_PREVIEW_INTERVAL_MS`) per running Claude/Codex task with native work evidence and calls `store.update(taskId, { progressMessage })`. `progressMessage` is persisted (`src/core/api/task-session.ts`), so each change triggers an HP-2 persist and a `task_sessions_updated` browser delta.
- **Direction:** carry `progressMessage` on a presentation-only channel or a non-persisting update path.

### HP-4 — Medium-high (confirmed by inspection): every session delta re-renders every board card

- `web-ui/src/components/board/board-column.tsx` passes new inline `conversation` and `onClick` callbacks each render, defeating `memo(BoardCard)` (`board-card.tsx`). `mergeTaskSessionSummaryMap` (`web-ui/src/utils/session-summary-utils.ts`) always returns a new sessions object, so `BoardContext` (`board-provider.tsx`) changes identity and unmemoized `QuarterdeckBoard`/`BoardColumn` re-render. Each 150 ms server batch, fed by HP-3 and hooks, re-renders all visible cards. Minor: `quarterdeck-board.tsx` runs `flatMap().find()` per render.
- **Direction:** let `BoardCard` render conversation content from props (or memoize the callbacks) and memoize `BoardColumn`; keep unchanged session entries referentially stable.

### HP-5 — Likely explained: ~60 s runtime stall at 13:32:49–13:33:48 EDT

- 64 hook HTTP requests hit their client budgets unanswered, `locked-file-system` logged slow-lock warnings, and 14 requests then completed together (22–61 s, two POSTs at 169 s and 188 s). The timing matches the Clear Trash incident fixed in `27293863`. If a stall recurs on later builds, capture it with `quarterdeck diagnostics capture`; HP-1, HP-2, and HP-6 all contend for the same project lock.

### HP-6 — Medium (confirmed code paths): periodic readers take the per-project lock that hooks need

- The Claude title monitor (`src/server/native-task-title-monitor.ts`) runs `loadProjectBoardById` every 2 s per project with live Claude sessions, even when no card is eligible.
- `buildProjectsPayload` (`src/server/project-registry.ts`) re-reads the index and takes every registered project's lock (22 live) on each board publication, public-status change, and stream connect. Overlaps item #11 of the existing runtime fs/git bottleneck task.
- Execution-ownership reconciliation (`src/server/runtime-server.ts`) walks all projects and re-reads the index every 10 s.
- **Direction:** `ProjectBoardCommandService` is the single board writer, so serve board/revision from an in-memory cache it maintains, and cache the parsed index.

### HP-7 — Medium-low (confirmed): agent availability probes respawn on frequent reconnects

- `AGENT_AVAILABILITY_TTL_MS = 30_000` (`src/config/agent-registry.ts`). The browser runtime stream reconnected 42 times in 2 h (project switches); past the TTL each reconnect spawns `claude --version`, `codex --version`, Codex features, and `pi --version` (250–410 ms). 80 probe completions in 2 h.
- **Direction:** longer display TTL with invalidation on settings, PATH, or binary mtime change. Launch admission keeps its own fresh-result policy.

### HP-8 — Suspected: Codex output inspection delays browser output while Running

- `src/terminal/session-output-pipeline.ts` with `agent-session-adapters.ts`: while Codex is Running, each PTY chunk captures the visible screen (`translateToString` per row) and defers its browser broadcast until the headless xterm parse completes. Needs measurement before treating as a regression; Claude inspection is bounded to 5 s after Escape.

## Areas that looked fine

Store reads (`cloneSummary` of a 512-receipt summary ~14 µs; `listSummaries` for 13 tasks ~83 µs), terminal WebSocket batching and backpressure, mirror batching without viewers, terminal restore frequency, runtime-state delta batching, hook outbox replay, the reconciliation sweep, diagnostics journal appends, the in-memory source-hint store, incremental progress and Claude title readers, and web-ui stream store, terminal write queue, slot eviction, and notification memory. Git metadata polling was not audited deeply.
