# Dev Todo

Ordered hardest-first so easy items at the bottom are less likely to cause merge conflicts.

## 1. Rewrite backend in Go

Rewrite the Node.js/TypeScript runtime server in Go for better performance, concurrency, and single-binary distribution. A comprehensive research doc exists at [docs/research/2026-04-06-go-backend-conversion-guide.md](research/2026-04-06-go-backend-conversion-guide.md) covering all 34 API routes, WebSocket protocols, PTY management, state persistence, and agent adapters — use it as the primary reference, though it may drift as the Node backend evolves.

**Motivation**:
- Go's goroutine model is a natural fit for the core workload: process orchestration, concurrent file I/O, and WebSocket streaming
- Single static binary simplifies distribution (no Node.js runtime dependency)
- Better resource usage under high concurrency (10+ agents)

**Approach**:
- The frontend (React/Vite) stays as-is — only the backend changes
- Replace tRPC with a typed HTTP/WebSocket API (e.g. `chi` or stdlib mux + `gorilla/websocket`)
- Replace node-pty with Go PTY libraries (`creack/pty`)
- Port the state persistence layer (JSON files + file-system locks) directly — the Go equivalent is straightforward
- Port the agent adapter system (Claude, Codex) — these are mostly CLI argument builders
- The research doc is organized module-by-module to support incremental porting

## 2. Fix session persistence across restart and un-trash

Three overlapping problems with session continuity:

- ~~**Sessions break after crash/closure**~~: **Fixed.** Running sessions are now marked as interrupted during hydration and auto-restarted with `--continue` when the UI reconnects. Tasks stay in their columns; the agent resumes its conversation. Terminal scrollback from before the crash is still lost (in-memory only), but the agent picks up where it left off.
- ~~**Auto-trashing on graceful shutdown**~~: **Fixed.** Graceful shutdown now preserves cards in their columns and marks sessions as "interrupted" with `pid: null`. On restart, the crash-recovery auto-restart infrastructure picks them up — same as after an unexpected crash.
- **Un-trash doesn't reliably auto-resume**: After un-trashing a task, the terminal sometimes shows the original prompt but not the rest of the conversation context. Manually typing `/resume` works and brings back the full session. Investigate why auto-resume doesn't reliably trigger on un-trash.

## 3. Performance audit for concurrent agents

Audit and address performance bottlenecks that emerge when running many agents simultaneously. An earlier analysis exists at [docs/performance-bottleneck-analysis.md](performance-bottleneck-analysis.md) but is likely out of date — use it as a starting point, not a source of truth. Key areas to re-evaluate:

- State persistence lock contention under concurrent checkpoint writes
- WebSocket broadcast fan-out scaling with multiple agents and browser tabs
- Frontend memory growth (chat messages, terminal cache) over long sessions
- PTY output fanout and shared backpressure across viewers
- Large diffs cause noticeable UI lag — full file text (old + new) is sent inline and diff computation happens client-side, so tasks with many changed files or large files bog down the browser
- Profile real-world usage with 5–10 concurrent agents to identify any new bottlenecks introduced since the earlier analysis

## 4. Branch management in git view

Add branch operations within the git view. The branch pill, git stats, fetch/pull/push, and right-click context menus already exist — this is about adding the interactive git operations on top.

**Done:**
- Right-click context menu on `BranchSelectorPopover` — checkout, compare with local tree, copy branch name
- Compare tab — diff any two refs with full file tree + diff viewer
- Merge branch into current — context menu action, attempts merge with auto-abort on conflict + toast feedback
- Create branch from ref — right-click context menu action in both branch selector popover and git history refs panel, with dialog for branch name entry
- Delete branch — context menu action with confirmation dialog, uses `git branch -d` (safe delete), disabled for current/worktree-locked branches, errors through centralized git error toast pipeline
- Conflict handling — merge/rebase conflict resolution with pause-on-conflict, ours/theirs diff previews, per-file resolution actions, multi-round rebase support, auto-merged file detection/review, persistent conflict banner, and auto-open resolver
- Cherry-pick commit — "Land on..." dropdown in git history commit diff header, cherry-picks individual commits onto any local branch via temp worktree, with confirmation dialog and skip-confirmation setting
- Pull/push to remote — context menu action on any local branch (non-current branches use `git fetch origin X:X` for pull and `git push origin X` for push), task-scoped with worktree directory resolution, ahead/behind indicators on branch pill
- Commit & Push — combined commit-and-push button in commit sidebar with detached HEAD detection
- Stash / unstash — stash button in commit sidebar (respects file selection, always includes untracked), collapsible stash list with pop/apply/drop/diff-preview, "Stash & Switch" for blocked checkouts, "Stash & Pull" with atomic stash→pull→auto-pop

**Tier 2 — Valuable but less frequent:**
- **Rebase onto** — Rebase a task branch onto latest main before merging. Keeps history linear.
- **Rename branch** — Minor convenience but nice for fixing typos.
- **Abort merge/rebase** — Escape hatch when conflict resolution goes sideways. Should be prominent when repo is in a conflicted state.

**Tier 3 — Nice-to-have, power user:**
- **Interactive rebase** (reorder/squash commits) — Hard to do well in UI, questionable ROI.
- **Tag management** — Less relevant for the agent-worktree workflow.
- **Force push** — Dangerous, but sometimes needed after rebase. Requires confirmation dialog.
- **Revert commit** — Undo a specific commit without rewriting history.

**UI surface areas:**
- Branch context menu in `BranchSelectorPopover` — merge done; add delete, rename, create branch actions
- Branch context menu in `GitRefsPanel` (git history view) — extend with the same actions
- Git view tab bar or toolbar — stash controls, conflict state indicator, abort button

## 5. Per-task session identity for non-isolated tasks

The client-side trash/untrash/start bugs for non-isolated tasks are fixed — `ensureTaskWorkspace` is no longer called (no orphan worktrees), dialog/toast messaging is correct, cleanup is skipped. However, the deeper session-scoping problem remains:

- **Session clobbering**: `--continue` picks the most recent conversation by CWD. Non-isolated tasks sharing the home repo all compete for the same "most recent" session. A warning toast now discloses this limitation on restore and restart, but there's no per-task session targeting.
- **Possible fix**: If Claude Code adds a `--session-id` or `--resume <id>` flag in the future, Quarterdeck could store the session ID per task and resume the correct conversation. Until then, this is a known limitation for non-isolated tasks.

## 6. Fix agent state tracking bugs

Multiple related bugs where the UI shows the wrong task state. A comprehensive analysis and refactor plan exists at [docs/refactor-session-lifecycle.md](refactor-session-lifecycle.md) — it covers root causes, targeted patches, and a structural decomposition of `session-manager.ts`.

**Fixed:**
- ~~**Permission race condition** (high)~~: Stale `PostToolUse` after `PermissionRequest` no longer bounces state back to running. Permission-aware transition guard in `hooks-api.ts` blocks `to_in_progress` during permission state (exempts `UserPromptSubmit`).
- ~~**Hook delivery timeouts** (low)~~: Checkpoint capture is now fire-and-forget — tRPC response returns immediately after state transition, preventing CLI timeouts.
- ~~**API errors leave session stuck in "running"** (medium)~~: Reconciliation sweep now detects running sessions that haven't received a hook in over 60 seconds and marks them as stalled. UI shows an orange "Stalled" badge with explanatory tooltip. Auto-clears when hooks resume.

**Remaining issues:**
- **Non-hook operations stick in wrong state** (medium): Auto-compact, plugin reload, and `/resume` produce no hook events. Compact and plugin reload get stuck in "running"; `/resume` after review doesn't transition back to running.
- **Notification beep count wrong for rapid transitions** (low): When a task goes to review then quickly to needs-input, wrong beep count plays. Debounce/settle window issues cause double-beeps for single events or single beeps for multiple events.

## 7. Client-side project switch optimizations

Server-side latency for project switching has been addressed (metadata decoupled from snapshot, file reads parallelized, inactive project task counts cached). Preload-on-hover is done. Remaining client-side strategy to make switching feel instant:

- **Stale-while-revalidate**: Cache board state per project in memory. On switch, show the cached version immediately while fresh data loads. Requires careful gating of `canPersistWorkspaceState` and `workspaceRevision` to prevent stale data from being persisted back to disk.

## 8. Upstream sync: periodic review of cline/kanban (recurring)

Periodically review the upstream [cline/kanban](https://github.com/cline/kanban) project for recent bug fixes and improvements worth reimplementing. The codebase has diverged significantly (200+ commits, `cline-sdk/` removed entirely) so most changes need reimplementation rather than direct cherry-picks. Roughly half of upstream output is Cline SDK/account work that will never apply; the other half is shared UI/UX where ideas are portable even if code isn't.

**Cadence:** Check weekly-ish. Run `git fetch upstream && git log upstream/main --oneline --since="<last check date>"` and evaluate new commits.
**Tracker:** [docs/upstream-sync.md](upstream-sync.md) — living doc with Adopted / Backlog / Decided against sections. Update it after each review.

## 9. Audit CI/CD and deployment infrastructure

Review the existing GitHub Actions workflows (`ci.yml`, `test.yml`, `publish.yml`), issue templates, CODEOWNERS, and the changelog extraction script. Decide what's still relevant from the upstream fork, what needs updating (e.g. Slack webhook, CODEOWNERS), and whether anything is missing (e.g. automated changelog generation, release notes workflow).

## 10. Publish to npm

Register the `quarterdeck` package on npm, configure OIDC trusted publishing for the GitHub repo, and do the first publish via the existing `publish.yml` workflow. Once published, update the README install instructions to use `npx quarterdeck` / `npm i -g quarterdeck` instead of the current clone-and-build steps.

## 11. Archive stale docs (recurring)

Periodically read through docs in `docs/` (research, plans, specs, top-level) and archive anything that's for completed work. Clean up stale or outdated documents. Docs accumulate as features ship — this isn't a one-time task.

## 12. UI branch/status indicators desync when agent leaves worktree

When `worktreeAddParentRepoDir` or `worktreeAddQuarterdeckDir` are enabled, agents can `cd` out of their assigned worktree into the home repo or other directories. The status bar branch pill, task card branch label, and branch selector dropdown all derive their values from the agent's current working directory (via the metadata monitor's git probe), so they start showing the home repo's branch state instead of the worktree's. Fix the metadata monitor and/or display logic so that task-scoped UI elements always reflect the assigned worktree path, not wherever the agent's shell happens to be. The statusline (`buildStatuslineCommand`) may also need the same fix.

## 13. "Shared" indicator on task cards should update when agent moves to shared directory

Task cards show a "shared" badge when a task is operating in the shared home workspace instead of an isolated worktree. When `worktreeAddParentRepoDir` is enabled, an agent that was started in an isolated worktree can `cd` into the home repo — at that point the task is effectively operating in shared space, but the card still shows as isolated. The "shared" indicator should react to the agent's actual working directory, not just the initial launch config. Both `worktreeAddParentRepoDir` and `worktreeAddQuarterdeckDir` can cause this — they let the agent escape the worktree sandbox, so any indicator that assumes worktree isolation needs to account for directory drift.

## 14. Add clarification when multiple worktrees share the same detached HEAD hash

When tasks are created without a feature branch, their worktrees are all detached at the same base commit. The status bar, card branch pill, and branch dropdown all show the same short commit hash, which looks like a bug. Add a tooltip or subtle label at these display points explaining that the worktrees are independent copies detached from the same base ref — changes in one won't affect others. Consider showing "detached from {baseRef}" instead of just the raw hash.

## 15. Test git object sharing as a read-only alternative to --add-dir

Git worktrees share the full object database with the parent repo, so agents can already read any file from any branch via `git show main:path/to/file` without filesystem access to the parent directory. Test whether this is a viable alternative to `worktreeAddParentRepoDir` — if agents can reliably read reference files (CLAUDE.md, docs, configs) through git commands, the `--add-dir` flags may be unnecessary for most use cases. Would avoid the worktree isolation breakage entirely. May need a system prompt hint so agents know to use `git show` instead of trying to navigate to the parent repo.

## 16. Revisit HTML chat view concept

The experimental HTML chat view (`terminalChatViewEnabled`) was removed because the implementation was incomplete and noisy — it stripped ANSI formatting and read from xterm's buffer, but output was unreliable for full-screen TUIs like Claude Code. Revisit the concept at some point: rendering agent output as styled HTML instead of a terminal canvas could enable better text selection, search, copy/paste, and accessibility. Would need a fundamentally different approach — likely parsing the agent's structured output (if available) rather than scraping the terminal buffer.

## 17. Commit sidebar: Auto-generated commit messages

Auto-generate a default commit message in the commit sidebar from the task title and diff summary (changed file names, additions/deletions count). The message should be pre-filled but fully editable before committing. Consider using the task description and branch name as additional context for message generation.

## 18. Full Codex support

Codex has basic launch, event parsing, and workspace trust working, but it's far from feature parity with Claude. The infrastructure is "make it run" — this is about "make it first-class."

**What works today:**
- Agent registration, selection, and onboarding UI
- CLI launch via `codexAdapter` (autonomous mode, resume, plan mode)
- Hook wrapper (`codex-wrapper`) with session log and rollout log event parsing
- Workspace trust auto-confirmation
- Prompt readiness detection

**Missing — core gaps:**
- **Conversation history in UI**: Claude exposes chat messages via API; Codex has no equivalent. The sidebar chat view is blank for Codex tasks. Need to either parse Codex session logs into a chat-like format or build a Codex-specific history endpoint.
- **Per-task session resume**: Resume uses `codex resume --last` which picks the most recent session globally, not per-task. Same session-clobbering problem as Claude non-isolated tasks (todo #5). If Codex adds session ID targeting, wire it up.
- **Hook configuration**: Claude gets a full `settings.json` with hook matchers (`PreToolUse`, `PostToolUse`, etc.). Codex gets nothing — the wrapper is a thin pass-through. Need to define what Codex-side hook configuration looks like and whether it can support the same granularity.
- **Error diagnostics**: If session logs aren't written or rollout file discovery fails, failures are silent. Add explicit error reporting when both log sources fail, and surface it in the UI.

**Missing — polish:**
- No Codex-specific documentation or setup guide
- No version detection or capability checking beyond `isBinaryAvailableOnPath()`
- Rollout file discovery scans up to 250 files by CWD match — may need optimization for heavy usage
- Non-hook operations (auto-compact, plugin reload, `/resume`) likely have the same stuck-state issues as Claude (todo #6)

## 19. Commit sidebar performance

Committing from the sidebar is noticeably slow — there's a delay after clicking the commit button, and then a further delay before the file list refreshes to reflect the new state. Investigate and fix both:

- **Commit execution latency**: Profile the commit path from button click through the tRPC call to the git commit completing. Check whether the commit is waiting on unnecessary work (full status refresh, lock contention, diff recomputation) before or during the actual `git commit`.
- **Post-commit file list refresh**: After the commit completes, the staged/unstaged file list takes too long to update. Check whether it's re-scanning the entire worktree, re-running expensive git commands sequentially, or waiting on a full state persistence cycle before refreshing the UI.
- Consider optimistic UI updates — clear the staged files immediately on commit success and refresh in the background.

## 20. File browser and diff viewer performance

The file browser and diff viewer are laggy, especially for tasks with many changed files or large diffs. Investigate and address:

- **File browser**: Slow to load and navigate. Profile whether the bottleneck is git command execution (status, ls-files), data transfer over WebSocket, or React rendering. Tree expansion and file selection should feel instant.
- **Diff viewer**: Large diffs cause noticeable UI lag. Full file text (old + new) is sent inline and diff computation happens client-side. Consider server-side diff computation, virtualized rendering for large files, or lazy-loading diffs per file instead of all at once.
- **Interaction between the two**: Selecting a file in the browser triggers a diff load — if this round-trips to the server each time, latency compounds. Consider pre-fetching diffs for visible files or caching previously viewed diffs.

## 21. Investigate deeper App.tsx state architecture refactor

The custom hook extraction (done in 0.7.2) reduces file size but doesn't fix the root issue: App.tsx is the single wiring hub because all state lives in React and flows down as props. Investigate options for decoupling state from the component tree so components can subscribe directly:

- **React Context providers** — split state into domain-specific contexts (board, sessions, config, git). Standard React, no new deps. Risk: re-render cascades if contexts aren't split granularly enough.
- **Zustand or Jotai** — lightweight external stores. Components subscribe to slices, minimal re-renders. Risk: migration cost, new dependency, coexistence with the existing Immer reducer.
- **Expand the `useSyncExternalStore` pattern** — already used for workspace metadata. Could generalize to board state and sessions. Risk: more boilerplate than Zustand, but zero new deps.

This is an investigation — evaluate each option against the codebase's actual coupling patterns before committing to one. The right answer depends on which state domains are most heavily prop-drilled and how many components would benefit.

## 24. Code duplication cleanup

Work through the findings in [docs/code-duplication-audit.md](code-duplication-audit.md) — 14 items covering duplicated logic across both runtime and web-ui. A detailed audit with specific files, line numbers, and consolidation approaches for each.

**Done:**
- ~~Phase 1~~: Removed duplicate `validateRef`, made auto-review-mode stubs functional
- ~~Phase 2~~: Consolidated numstat parsing (`parseNumstatTotals`, `parseNumstatLine`, `countLines` in `git-utils.ts`), extracted shared `FileFingerprint` + builder (`file-fingerprint.ts`), added shared `resolveRepoRoot` to `git-utils.ts`
- ~~Phase 3 (partial)~~: Extracted `isNodeError` to `src/fs/node-error.ts`, consolidated `runGitCapture` as `runGitSync` in `git-utils.ts`
- ~~Phase 5 (partial)~~: Extracted `toErrorMessage` to `web-ui/src/utils/to-error-message.ts`, updated 18 files

**Remaining:**
- **ConfirmationDialog wrapper** — Create reusable component to collapse 17 near-identical dialog files. Needs visual testing.
- **Cross-boundary ANSI stripping** — Share runtime's `stripAnsi` implementation with web-ui
- **Git error formatting round-trip** — Runtime wraps errors in boilerplate, web-ui regex-strips it back out

**Skipped (low ROI):**
- Path normalization (#9) — divergent semantics are intentional per platform
- `useLatestRef` / `useRequestId` hooks — too few instances (~10 and 3) to justify abstractions
