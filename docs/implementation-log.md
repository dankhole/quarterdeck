# Implementation Log

> Prior entries in `docs/history/`: `implementation-log-through-0.12.0.md`, `implementation-log-through-0.11.0.md`, `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

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
