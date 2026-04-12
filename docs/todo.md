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

- **Sessions break after crash/closure**: When Quarterdeck crashes or is closed and reopened, clicking on existing cards no longer works — the agent chat is unresponsive/broken. Need to reconnect or re-attach to the Claude conversation so the agent can continue where it left off. If the old session can't be resumed, offer to start a fresh session in the same worktree/branch context.
- **Auto-trashing on restart**: All open tasks (in_progress, review) get moved to trash when Quarterdeck restarts. Investigate whether this is a technical requirement (agent sessions can't be resumed so tasks are considered dead) or just an early UX decision that was never revisited. Losing board state on every restart is disruptive, especially for tasks with meaningful progress. Keeping cards in place may be possible even if full session resumption isn't.
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
- Conflict handling — merge/rebase conflict resolution with pause-on-conflict, ours/theirs diff previews, per-file resolution actions, and multi-round rebase support
- Cherry-pick commit — "Land on..." dropdown in git history commit diff header, cherry-picks individual commits onto any local branch via temp worktree, with confirmation dialog and skip-confirmation setting

**Tier 1 — High value, users hit these constantly:**
- **Stash / unstash** — "Save my spot" before switching context. Especially useful when checkout is blocked by uncommitted changes (pull already blocks on this). Show stash list, allow pop/apply/drop.

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

## 17. Commit sidebar: Commit and Push button

Add a "Commit and Push" button alongside the existing Commit button in the commit sidebar tab. The push infrastructure already exists (`runGitSyncAction("push")`). This is the combined flow — commit then push in one action. Should handle push failures gracefully (commit succeeds but push fails → toast with error, commit is preserved).

## 18. Commit sidebar: Auto-generated commit messages

Auto-generate a default commit message in the commit sidebar from the task title and diff summary (changed file names, additions/deletions count). The message should be pre-filled but fully editable before committing. Consider using the task description and branch name as additional context for message generation.
