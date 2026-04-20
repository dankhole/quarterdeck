# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Fix lint warnings and flaky integration test (2026-04-20)

**What:** Resolved all 12 Biome lint warnings (11 `noNonNullAssertion`, 1 `noUnusedImports`) and fixed the flaky `task-command-exit.integration.test.ts` that failed under parallel test load.

**Why:** The lint warnings were all `style/noNonNullAssertion` on array/regex indexing that was already guarded by prior checks — safe at runtime but flagged by the linter. The test flake had a deeper cause: when a second CLI invocation detects an existing server (EADDRINUSE), it opens a browser tab via the `open` package and then `return`s from `runMainCommand`. The caller `run()` only calls `process.exit()` for non-launch invocations, so launch invocations relied on Node's natural event-loop drain. Under parallel load, the `open` package's spawned subprocess and its Promise error listeners kept the loop alive past the 8-second `waitForExit` timeout, causing `didExit` to be `false`.

**How:**
- Replaced `!` assertions with `as` type narrowing (where a length/match guard makes the value guaranteed) or `?? fallback` (for regex capture groups and parsed values) across `src/commands/statusline.ts`, `src/terminal/session-summary-store.ts`, `src/terminal/terminal-protocol-filter.ts`, `src/workdir/get-workdir-changes.ts`, `src/workdir/git-stash.ts`.
- Removed unused `RuntimeStateStreamTransport` type import from `web-ui/src/runtime/runtime-state-stream-transport.test.ts`.
- Changed the EADDRINUSE early-return in `src/cli.ts` (`runMainCommand`, line 604) from `return` to `process.exit(0)` — this is a terminal path where the CLI successfully handed off to an existing server and has no remaining work.

**Files touched:** `src/cli.ts`, `src/commands/statusline.ts`, `src/terminal/session-summary-store.ts`, `src/terminal/terminal-protocol-filter.ts`, `src/workdir/get-workdir-changes.ts`, `src/workdir/git-stash.ts`, `web-ui/src/runtime/runtime-state-stream-transport.test.ts`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Follow-up: tighten authoritative apply review nits and cache-reprojection coverage (2026-04-20)

**Commit:** `(uncommitted in worktree)`

**What:** Applied the small but worthwhile follow-up fixes from review on the new authoritative project-apply path: removed a redundant outer revision check, simplified the authoritative apply result shape, trimmed unnecessary ref dependencies, and added the missing direct regression test for same-revision cache confirmation that still needs board reprojection.

**Why:** None of these were correctness regressions in production, but they were exactly the kind of small ambiguities that make a new architecture seam easier to drift away from. The redundant `shouldApplyProjectUpdate()` call in `use-project-sync.ts` made the `null` branch from `applyAuthoritativeProjectState()` look reachable when it was really dead in that path, the duplicated `reconciledSessions` field widened the authoritative apply surface for no benefit, and the missing `confirm_cache` + reprojection test left one of the documented invariants unencoded in the suite.

**How:**
- Removed the outer `shouldApplyProjectUpdate()` guard from `web-ui/src/hooks/project/use-project-sync.ts` and let `applyAuthoritativeProjectState()` remain the single place that decides whether an authoritative update is skipped.
- Simplified `AuthoritativeProjectStateApplyResult` in `web-ui/src/hooks/project/project-sync.ts` by dropping the redundant `reconciledSessions` field and using `nextState.sessions` at the cache-update callsite instead.
- Removed the unnecessary `projectBoardSessionsRef` entries from the hook callback dependency arrays since the ref object identity is stable.
- Added a focused unit test in `web-ui/src/hooks/project/project-sync.test.ts` proving that `boardAction === "confirm_cache"` can still bump the hydration nonce and move a card from `in_progress` to `review` when same-revision authoritative runtime truth disagrees with the cached board’s work-column placement.

**Files touched:** `web-ui/src/hooks/project/project-sync.ts`, `web-ui/src/hooks/project/use-project-sync.ts`, `web-ui/src/hooks/project/project-sync.test.ts`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Follow-up: make authoritative project sync apply atomically from one board/session snapshot (2026-04-20)

**Commit:** `(uncommitted in worktree)`

**What:** Landed the first implementation slice of the split-brain task-state follow-up by making browser-side authoritative project-state application compute from one coherent local `board + sessions` snapshot instead of separate refs/writes. The new path now derives session reconciliation, board projection, hydration policy, cache updates, and revision/persistence re-entry from one pure apply result.

**Why:** The earlier refactor clarified the ownership model, but `web-ui/src/hooks/project/use-project-sync.ts` still had a correctness hole: it reconciled authoritative sessions from `sessionsRef.current`, projected board state from `boardRef.current`, then committed those pieces through separate writes. That left a race where a newer session delta could land between snapshot and commit and get clobbered, and it made same-revision confirmation/project-switch behavior depend too much on incidental ordering rather than one explicit authoritative-apply contract.

**How:**
- Reworked the app shell in `web-ui/src/App.tsx` to hold `board` and `sessions` behind one shared `ProjectBoardSessionsState` seam plus synchronized wrapper setters. The wrappers update a shared ref immediately before scheduling React state, so authoritative sync code can read the latest queued local board/session state instead of stale render-time refs.
- Updated `web-ui/src/providers/project-provider.tsx` and `web-ui/src/hooks/project/use-project-sync.ts` to use that shared seam. `use-project-sync` now resets, cache-restores, stashes, and authoritatively applies `board + sessions` together instead of mixing separate `setBoard` / `setSessions` snapshots.
- Added `applyAuthoritativeProjectState()` in `web-ui/src/hooks/project/project-sync.ts`. The helper is now named as the explicit browser-side entry point for authoritative project state: it takes the latest local board+sessions state, current revision/cache context, and incoming authoritative project state, then returns the single apply result used for reconciled sessions, projected board, hydration nonce/skip-persist policy, and the board/session payload written back into `project-board-cache`.
- Expanded `web-ui/src/hooks/project/project-sync.test.ts` and `web-ui/src/hooks/project/use-project-sync.test.tsx` so the pure helper and hook both cover the new atomic-authoritative-apply seam directly, including projection from reconciled sessions and same-revision cache confirmation behavior.
- Updated `CHANGELOG.md` and `docs/task-state-system.md` so the new contract is documented explicitly: authoritative project-state apply is now one browser-side join point over the latest queued local board+sessions state, not a series of independent writes.

**Files touched:** `web-ui/src/App.tsx`, `web-ui/src/providers/project-provider.tsx`, `web-ui/src/hooks/project/use-project-sync.ts`, `web-ui/src/hooks/project/project-sync.ts`, `web-ui/src/hooks/project/use-project-sync.test.tsx`, `web-ui/src/hooks/project/project-sync.test.ts`, `docs/task-state-system.md`, `CHANGELOG.md`, `docs/implementation-log.md`.
