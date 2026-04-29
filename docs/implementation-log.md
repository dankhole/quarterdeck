# Implementation Log

> Prior entries in `docs/history/`: `implementation-log-through-0.12.0.md`, `implementation-log-through-0.11.0.md`, `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## 2026-04-29 — Task-owned agent harness selection

Task creation now owns agent harness choice per task instead of requiring a global Settings change. The selected harness is persisted on `RuntimeBoardCard.agentId`, browser task creation writes it into board state, and fresh task starts prefer the persisted card agent before falling back to the runtime default. Resume still prefers the previous terminal summary agent so existing conversations continue with the same CLI. Settings no longer renders the task-agent picker; it keeps launch tuning such as Claude row multiplier and the worktree context prompt.

Task cards show the effective harness in the lower metadata row and no longer render transient last-tool or agent-message activity there, keeping mixed-agent boards readable without adding another header chip. A refinement pass removed the now-unused task activity formatter after the card stopped displaying last-tool activity, and settings now leads with PATH-based harness detection guidance plus the debug-log shortcut before lower-priority launch tuning. Notable files: `src/core/api/board.ts`, `src/core/api/task-session.ts`, `src/trpc/handlers/start-task-session.ts`, `web-ui/src/components/task/task-create-dialog.tsx`, `web-ui/src/components/task/task-agent-selector.tsx`, and `web-ui/src/components/board/board-card.tsx`. Validation: focused web/runtime tests, `npm run web:typecheck`, `npm run typecheck`, `npm run web:build`, `npm run test:fast`, `git diff --check`, and Biome on touched files.

## 2026-04-29 — Windows support audit refresh

The Windows support audit now has a stable record in `docs/windows-support-audit.md` instead of one broad active todo. The current boundary is explicit: Quarterdeck has Windows handling for path normalization, shell selection, folder picking, command-shim PTY launch, junction-based ignored-path mirroring, and process timeout cleanup, but support remains experimental until native Windows CI or smoke testing covers the main runtime flows.

This pass fixed concrete audit findings: agent availability/version probes now route ambiguous Windows command shims through `ComSpec`, worktree-home containment normalizes separators and drive-letter casing before rejecting managed worktrees as projects, `dev:full` uses `npm.cmd` for the web UI child, dev/e2e wrappers avoid SIGHUP on Windows, and startup/shutdown orphan cleanup now has a Windows process discovery/tree-termination path instead of returning no work. The cleanup recognizes direct agent executables plus known agent CLI command lines hosted by `node.exe`/`cmd.exe` wrappers. Remaining risk is tracked as focused follow-ups for Windows CI/manual smoke, shared `cmd.exe` shell-string escaping, ConPTY resize/restore validation, and a scoped PID registry if native smoke shows descendants that cannot be identified safely from known executable names or hosted command lines. Validation: focused runtime tests for agent registry, project-state utilities, shell helpers, Windows command launch, and orphan cleanup.

## 2026-04-29 — Runtime request and launch hardening

Runtime HTTP requests, runtime-state WebSocket upgrades, and terminal WebSocket upgrades now share a host/origin gate in `src/server/middleware.ts`. Requests without an `Origin` header still work for CLI/local fetches, while browser requests must come from the configured runtime origin, loopback aliases on the runtime port, or explicit development web UI ports when `NODE_ENV=development`. The dev runtime launcher now sets that mode, and Playwright e2e passes its web port so the Vite proxy remains covered without opening the policy broadly in packaged runs.

The same upstream review also landed two low-risk launch/identity hardening fixes: Codex launches receive `-c check_for_update_on_startup=false` unless a user override already exists, and UUID-unavailable task ID fallbacks no longer mix `Date.now()` into short IDs. Validation: `npm run check`, `npm run web:typecheck`, `npm run web:test`, `npm run lint`, `node --check scripts/dev-runtime.mjs`, and `git diff --check`.

## 2026-04-29 — Lightweight LLM generation reliability

Lightweight helper generation now has one provider-neutral OpenAI-compatible client in `src/title/llm-client.ts`. `QUARTERDECK_LLM_BASE_URL`, `QUARTERDECK_LLM_API_KEY`, and `QUARTERDECK_LLM_MODEL` are the required configuration path. The timeout classifier now treats both `AbortError` and `TimeoutError` as timeouts, so logs match the real failure mode.

Title, optional summary polish, branch-name, and commit-message generation are the only LLM call sites. Title and display-summary context now orders source material by product value: original user prompt, first agent summary, most recent agent summary, then the previous summary. Title and commit-message generation also have deterministic local fallbacks, so transient helper failures no longer leave task cards untitled or the commit sidebar empty. Title and summary compaction also trims trailing transcript echo fragments such as `Human:` / `Assistant:` and rejects outputs that are only a transcript echo.

The card-summary path is intentionally lighter: board-card hover no longer triggers an LLM mutation, and the old hover staleness control has been removed. Agent transcript/hook summaries are compacted locally for immediate card display. When `llmSummaryPolishEnabled` is on, task starts and hook-driven moves into in-progress/review can enqueue a best-effort background polish using the same weighted context; repeated bounces skip work when the stored LLM summary is already newer than the source text.

Notable files: `src/title/*`, `src/trpc/project-procedures.ts`, `src/trpc/display-summary-polish.ts`, `src/terminal/session-summary-store.ts`, `web-ui/src/components/settings/display-sections.tsx`, and board card action wiring. Validation: focused title, LLM client, summary, commit-message, session-store, hook-summary, and summary-polish tests. Commit: pending.

## 2026-04-29 — Frontend terminal pool state ownership

Shared pooled task-terminal bookkeeping now lives in `web-ui/src/terminal/terminal-pool-state.ts`. `TerminalPoolState` owns the slot array, role map, role timestamps, task-to-slot index, role-based oldest/newest selection, task assignment/removal, rotation replacement metadata, and test/HMR clearing. `terminal-pool.ts` remains the composition root for creating/disposing `TerminalSlot` instances, socket connect/disconnect, policy timers, diagnostics providers, dedicated terminal compatibility, and the public pool API.

The key invariant is unchanged behavior: `FREE`, `PRELOADING`, `READY`, `ACTIVE`, and `PREVIOUS` semantics stay the same; warmup max TTL, cancel grace, previous eviction, restore-on-promotion, debug dump hook, HMR cleanup, and dedicated shell terminal separation are preserved. Validation: focused terminal pool/dedicated/diagnostics/session hook suite.

## 2026-04-29 — Project metadata loader module split

Project metadata loading now keeps the existing refresh architecture while splitting the large loader facade into explicit modules for task path resolution, checkout-level git probing, base-ref lookup, task projection, home metadata, and entry/snapshot helpers. `src/server/project-metadata-loaders.ts` remains the compatibility import surface, and `project-metadata-task-cache.ts` owns the cached task metadata type so the leaf modules avoid circular runtime imports.

The key invariant is unchanged behavior: refreshers still resolve each task's assigned path, group loads by `normalizedPath`, probe each physical checkout once, project task/base-ref-specific fields separately, and leave freshness/stale-write ownership in `ProjectMetadataRefresher` and `ProjectMetadataController`. Notable files: `src/server/project-metadata-*.ts`. Validation: `npm run test:fast -- project-metadata`, `npm run check`, and independent code review.

## 2026-04-29 — Project metadata visibility ownership

Project metadata visibility is now owned per browser runtime client instead of as one project-scoped last-writer flag. The web UI sends a per-page client id on the runtime state WebSocket and tRPC visibility calls, plus the current document visibility in the WebSocket handshake so reconnects preserve hidden state; `RuntimeStateClientRegistry` removes that client's contribution on socket disconnect; and `ProjectMetadataController` derives effective project visibility as "any active client visible" before applying the existing poller and remote-fetch cadence policies.

The key invariant is that visibility only tunes metadata refresh policy. Board/task state ownership, task metadata projection, polling intervals, remote-fetch timing, and timeout classes did not move. Notable files: `web-ui/src/runtime/runtime-client-id.ts`, `src/server/project-metadata-visibility.ts`, `src/server/project-metadata-controller.ts`, `src/server/runtime-state-hub.ts`, and `src/server/runtime-state-client-registry.ts`. Validation: focused project metadata visibility/controller tests.

## 2026-04-29 — Diff content loading priority

Git diff content loading now separates the fetch/cache mechanism from the view policy. `useAllFileDiffContent(...)` keeps per-file cache, abort, stale-response, and `contentRevision` invalidation behavior, while its scheduling input is now an ordered foreground path list plus a capped background prefetch policy. `GitView` supplies selected and visible diff paths, and `DiffViewerPanel` reports visible sections from the scroll surface with overscan. In-flight diff requests are deduped across scroll-driven reprioritization so aborting a local pass does not issue the same backend request twice.

The key invariant is that correctness depends only on requested paths: selecting or revealing a file requests its diff promptly, and offscreen prefetch can be reduced or disabled without breaking the tab. Cached content remains visible during refresh, failed background refreshes keep the last good diff, and failed uncached prefetches do not poison the cache or mark the file loaded. Notable files: `web-ui/src/runtime/use-all-file-diff-content.ts`, `web-ui/src/runtime/all-file-diff-content.ts`, `web-ui/src/hooks/git/use-git-view.ts`, and `web-ui/src/components/git/panels/diff-viewer-panel.tsx`. Validation: `npm run web:test -- src/runtime/use-all-file-diff-content.test.tsx src/components/git/panels/diff-viewer-panel.test.tsx`; `npm run check`; `npm run build`.

## 2026-04-29 — Session launch path migration closure

The one-time local state rewrite is complete: scanning `/Users/d.cole/.quarterdeck` found no remaining `projectPath` keys in current `sessions.json` files, and the project state files now persist `sessionLaunchPath`. `RuntimeTaskSessionSummary` therefore no longer reads legacy `projectPath` as launch identity; the schema materializes `sessionLaunchPath` directly. For other state homes that still contain old records, persisted session loading rewrites `projectPath` into `sessionLaunchPath` before schema validation and saves the repaired `sessions.json`, keeping the public/runtime contract to one identity field without silently dropping launch identity.

This closes the final compatibility tail from the project/worktree identity normalization work. The invariant is that session launch identity has one public field, while project root path and assigned task worktree identity stay modeled separately. Notable files: `src/core/api/task-session.ts`, `src/state/project-state-index.ts`, `test/runtime/api-validation.test.ts`, `test/integration/project-state.integration.test.ts`, `docs/todo.md`, and `docs/architecture-roadmap.md`. Validation: local state scan for legacy keys, `npx vitest run test/runtime/api-validation.test.ts`, `npx vitest run test/integration/project-state.integration.test.ts`, and `npm run typecheck`.

## 2026-04-29 — Project metadata path-level projection

Task worktree metadata loading now has an explicit two-step boundary: resolve the task's assigned path, load checkout-level git state once for that normalized physical path, then project per-task metadata with task id and base-ref-specific fields. Full-project and background refreshes group tracked tasks by resolved path before probing, so multiple active shared-checkout tasks no longer run identical path/status/conflict reads against the project root. Base-ref-specific work remains keyed by base ref, preserving different `behindBaseCount` and unmerged-change projections for tasks sharing the same checkout.

The key invariant is that freshness and mutation ownership did not move: `ProjectMetadataController.commitTaskMetadata(...)` still gates each task result, stale full refreshes still cannot overwrite newer targeted task metadata, and background polling does not bump task freshness over an in-flight manual targeted refresh. Notable files: `src/server/project-metadata-loaders.ts`, `src/server/project-metadata-refresher.ts`, and focused monitor/loader tests under `test/runtime/server`. Validation: `npm run test:fast -- project-metadata`, `npm run check`.

## 2026-04-29 — Pi lifecycle extension source extraction

The Pi lifecycle hook bridge now lives in `src/terminal/pi-lifecycle-extension.runtime.js` as normal JavaScript source instead of a generated `String.raw` template in TypeScript. `src/terminal/pi-lifecycle-extension.ts` loads that asset, substitutes only the explicit hook-command env placeholder, and `scripts/build.mjs` copies the asset into `dist/terminal` so bundled `dist/cli.js` / `dist/index.js` can still write the extension before launching Pi.

The key invariant is unchanged launch-scoped behavior: `agent-session-adapters.ts` still writes `quarterdeck-lifecycle.js` under the Quarterdeck runtime hooks directory, passes it to Pi with `--extension`, and injects `QUARTERDECK_PI_HOOK_COMMAND_JSON` with the hook command. Validation: focused Pi lifecycle and adapter tests, `npm run check`, and `npm run build`.

## 2026-04-29 — Frontend terminal pool ownership split

`web-ui/src/terminal/terminal-pool.ts` now acts as the pooled task-terminal composition root instead of owning every terminal policy and diagnostic path directly. The pool keeps slot roles, task-slot indexing, acquire/release/releaseAll, restore-on-promotion decisions, and dedicated terminal compatibility exports. Hidden-stream bounds moved to `terminal-pool-policy.ts`, DOM/debug state and `window.__quarterdeckDumpTerminalState` moved to `terminal-pool-diagnostics.ts`, and pool-plus-dedicated helpers moved to `terminal-surface-helpers.ts`.

The key invariant is unchanged behavior: prewarm remains optional optimization around correct acquire/release semantics, the 12s warmup TTL / 3s cancel grace / 8s PREVIOUS eviction bounds are preserved, DOM monitoring still uses provider snapshots and HMR cleanup, and dedicated shell terminals remain separate from pooled task-agent terminals. Validation: focused terminal suite before and after the split.

## 2026-04-29 — Orphan maintenance boundary

Session reconciliation now covers only live task session/process drift: dead task PIDs, processless running sessions, interrupted sessions without pending restart, and stale hook activity. Generic process liveness moved to `src/terminal/process-liveness.ts`, so orphan-process cleanup no longer imports reconciliation policy. Periodic stale git `index.lock` cleanup moved out of `session-reconciliation-sweep.ts` into a named project orphan-maintenance timer wired from `ProjectRegistry`.

The cleanup taxonomy is documented in `src/server/project-orphan-maintenance.ts`: session drift stays on the reconciliation timer; orphan agent processes stay in startup/shutdown cleanup; filesystem locks stay in `src/fs/lock-cleanup.ts` with a project-level maintenance scheduler; orphan worktrees stay in explicit task/project removal flows; dangling state references stay in state prune/broadcast boundaries. Validation: focused runtime tests for session reconciliation, orphan cleanup, lock cleanup, shutdown coordination, and project orphan maintenance; typecheck; Biome on touched TypeScript files.

## 2026-04-29 — Unresolved base refs after task branch changes

Task branch-change reconciliation now treats a failed `resolveBaseRefForBranch(...)` inference as an explicit unresolved base-ref state instead of silently retaining the old base. The monitor broadcasts `baseRef: ""`, the board persists that value, and the top-bar base-ref pill prompts the user to select a base branch. Pinned base refs still ignore automatic updates.

The key invariant is that `""` is only a board/UI state, not a valid base for base-derived operations. Task path operations that can resolve an existing working directory remain task-scoped with an empty base ref, while task starts, worktree creation, base-derived diffs, commits/PRs, and base-derived badges wait for a selected base. Explicit-ref task comparisons stay task-scoped without needing the card base ref. Notable files: `src/server/project-metadata-refresher.ts`, `src/server/project-metadata-loaders.ts`, `src/trpc/project-api-shared.ts`, `web-ui/src/components/app/base-ref-label.tsx`, `web-ui/src/hooks/git/*`, and `web-ui/src/stores/project-metadata-store.ts`. Validation: `npm run check`.

## 2026-04-29 — Worktree add-dir settings removal

Quarterdeck no longer exposes or honors the Claude-only settings that added the parent repository `.git` directory or `~/.quarterdeck` to worktree-launched agents with `--add-dir`. Those toggles made the settings menu harder to reason about and weakened worktree isolation; task-agent launch now hardcodes those extra directory grants off. The config registry, public config schema, settings form, start-session request, startup resume path, and Claude adapter no longer carry the fields, so old persisted keys are ignored and will be pruned on the next config write.

Settings now groups task-agent selection, Claude row tuning, and the worktree context prompt in one launch section. Notable files: `src/config/global-config-fields.ts`, `src/core/api/config.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-lifecycle.ts`, and `web-ui/src/components/settings/agent-section.tsx`. Validation: `npm run check`, `npm run web:test`, and `npm run web:build`.

## 2026-04-29 - Compare Diff Refresh Targeting

- Compare/uncommitted diff loading now uses per-file `contentRevision` metadata from workdir change responses to decide which file diffs need refetching. Response-wide `generatedAt` remains a compatibility fallback only when content revisions are missing.
- Browser diff refreshes preserve enriched file object identity when fetched content is unchanged and keep the last good cached diff if a background refresh fails, reducing compare-tab scroll interruptions without hiding real file edits.
- Key files: `src/workdir/get-workdir-changes.ts`, `src/core/api/workdir-files.ts`, `web-ui/src/runtime/use-all-file-diff-content.ts`, `web-ui/src/runtime/all-file-diff-content.ts`, `web-ui/src/runtime/query-equality.ts`.
- Validation: focused diff-refresh tests during implementation, then squash-prep validation with `npm run check`, `npm run web:test`, and `npm run web:build`.

## 2026-04-29 - Task Terminal Restore Reveal Ordering

- Changed browser task-terminal restore presentation so readiness is reported after the xterm write queue drains, resize runs, the viewport scrolls to bottom across animation frames, and the host is revealed. The IO-open fallback now uses the same settled reveal path instead of immediately clearing the loading overlay. This protects Claude sessions, which can emit redraw/output bursts around restore, from becoming visible before the restored buffer has reached the bottom.
- Key files: `web-ui/src/terminal/terminal-viewport.ts`, `web-ui/src/terminal/terminal-session-handle.ts`, `web-ui/src/terminal/terminal-attachment-controller.ts`.
- Validation: `npm run web:test -- src/terminal/terminal-session-handle.test.ts src/terminal/terminal-attachment-controller.test.ts src/terminal/slot-socket-manager.test.ts`; `npm run web:build`.

## 2026-04-29 — Codex prompt option separator

Codex rejects prompt positionals that start with `-` unless they are preceded by `--`. The failure can surface through resume even though browser restart/restore sends an empty prompt, because terminal auto-restart clones the original task start request and then flips it to `resumeConversation=true` while preserving the original prompt. A task whose prompt starts with a bullet can therefore become `codex resume ... "- ..."` and fail in clap before the TUI opens.

The Codex adapter now appends `--` before prompt positionals after all `resume`, hook, feature, and developer-instruction arguments have been assembled. This uses Codex's standard CLI argument boundary for every prompt, protecting fresh starts and resume starts without changing no-prompt resume behavior. Notable files: `src/terminal/agent-session-adapters.ts` and `test/runtime/terminal/agent-session-adapters.test.ts`. Validation: targeted adapter tests, agent-instruction bridge check, and typecheck.

## 2026-04-29 — Live terminal write batching

Task terminal live IO now enters xterm through an explicit `TerminalWriteOptions.batch` path. `SlotSocketManager` marks only websocket IO chunks as batchable; restore snapshots, reset/clear actions, and local status text leave batching off. `SlotWriteQueue` coalesces same-kind string or byte chunks until the next animation frame, a 16 ms fallback timer, or size/count caps, then sends one aggregate `terminal.write` while preserving output-ack byte totals and output-text notifications.

The key invariant is ordering: `drain()`, `chainAction()`, and immediate writes all flush any pending live batch before restore/reset/status operations proceed. This keeps the untrash/reconnect restore guards intact while reducing browser main-thread churn from high-volume agent output. Notable files: `web-ui/src/terminal/slot-write-queue.ts`, `slot-socket-manager.ts`, `terminal-write-options.ts`, and focused queue/socket tests. Validation: `npm run typecheck`, `npm run test:fast`, and `npm run web:test -- src/terminal/slot-write-queue.test.ts src/terminal/slot-socket-manager.test.ts`.
