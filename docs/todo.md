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

## 4. Cherry-pick / land individual commits onto main from the UI

Add a UI action to land individual task commits (or a squashed commit) from a task worktree onto main without doing a full branch merge. This is the "ship this one thing" flow — you're reviewing a task's changes, you want to land them on main right now.

This is distinct from #6 (committing *within* the task worktree). This is a targeted "cherry-pick to main" action, likely surfaced as a button in the diff viewer or on the task card during review.

## 5. Branch management in git view

Add branch operations within the git view. The branch pill, git stats, fetch/pull/push, and right-click context menus already exist — this is about adding the interactive git operations on top.

**Done:**
- Right-click context menu on `BranchSelectorPopover` — checkout, compare with local tree, copy branch name
- Compare tab — diff any two refs with full file tree + diff viewer
- Merge branch into current — context menu action, attempts merge with auto-abort on conflict + toast feedback
- Create branch from ref — right-click context menu action in both branch selector popover and git history refs panel, with dialog for branch name entry

**Tier 1 — High value, users hit these constantly:**
- **Delete branch** — Cleanup after merge. Stale branches pile up fast with per-task worktrees. Guard against deleting the current branch or branches locked to active worktrees.
- **Stash / unstash** — "Save my spot" before switching context. Especially useful when checkout is blocked by uncommitted changes (pull already blocks on this). Show stash list, allow pop/apply/drop.
- **Conflict handling** — When a merge (or rebase, cherry-pick) produces conflicts, surface them clearly — show conflicted files, let the user abort. At minimum: conflict state indicator + abort action. Inline conflict resolution can come later.

**Tier 2 — Valuable but less frequent:**
- **Cherry-pick commit** — Pull specific commits from an agent's branch without merging everything. Relates to #4 (land individual commits to main).
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

## 6. Commit sidebar tab with server-side commit

New sidebar tab showing uncommitted changes as a file list with checkboxes for staging, a commit message input, and commit/push buttons at the bottom — similar to the JetBrains "Commit" tool window. Commits are executed server-side via `runGit()`, no agent session required. This is the quick-commit flow for the common case — commit without leaving your current main view.

- **File selection**: Checkboxes or select-all toggle to choose which files to stage. The file list mirrors what the diff viewer's file tree shows but in a compact sidebar format.
- **Commit message**: Inline text input. Auto-generate a default message from the task title and diff summary (changed file names, additions/deletions). Editable before committing.
- **Discard changes**: Move the "discard all working changes" action here (previously lived in the git history panel header, removed). The backend (`discardGitChanges` tRPC endpoint, `discardHomeWorkingChanges` in `useGitActions`) already exists — just needs to be wired into this new UI.
- **Backend**: New tRPC mutation (e.g. `runtime.commitTaskChanges`) that stages selected files and commits in the task worktree using `runGit()`.
- **Git view integration**: The git main view's Uncommitted tab shows full diffs — clicking a file in the commit sidebar could open the diff in the git view for review before committing. More complex git operations (merge, branch management) live in the git view (#5).

## 7. Move agent chat out of the project switcher sidebar

The agent chat UI currently lives inside the project switcher sidebar tab. It doesn't belong there — the project switcher should be focused on project selection and status. Extract the agent chat into its own location. The right destination is TBD — could be its own sidebar tab, a main view, a panel, or something else. Investigate where it fits best in the existing layout before committing to a placement.

## 8. Fix un-trash and restart for non-isolated worktree tasks

The trash → un-trash → resume cycle is broken for tasks that share the main repo (no isolated worktree). Two overlapping problems:

- **Session clobbering**: Un-trashing multiple shared-workspace tasks steals each other's sessions. The restore logic reattaches to the most recent agent chat session rather than the original one. Each subsequent un-trash takes the session from the previously restored task, and any external agent session in the same workspace replaces it too. Root issue: shared-workspace tasks all compete for a single "current session" with no per-task session scoping.
- **Branch and git state**: How does branch resume work when there's no dedicated worktree to switch back to? Does un-trashing correctly restore the branch context, or leave the task broken? Does the restart/reset session button assume a worktree exists? What git state is cleaned up on trash for non-worktree tasks, and can it be reversed on un-trash?

Needs a way to associate and restore the correct session per task even when they share a workspace, and ensure the full lifecycle works for both execution modes.

## 9. Fix agent state tracking bugs

Multiple related bugs where the UI shows the wrong task state. A comprehensive analysis and refactor plan exists at [docs/refactor-session-lifecycle.md](refactor-session-lifecycle.md) — it covers root causes, targeted patches, and a structural decomposition of `session-manager.ts`.

**Known issues:**
- **Permission race condition** (high): Task shows "running" when agent is blocked on a permission prompt. Stale `PostToolUse` hook arrives after `PermissionRequest`, bouncing state back to running.
- **Non-hook operations stick in wrong state** (medium): Auto-compact, plugin reload, and `/resume` produce no hook events. Compact and plugin reload get stuck in "running"; `/resume` after review doesn't transition back to running.
- **Notification beep count wrong for rapid transitions** (low): When a task goes to review then quickly to needs-input, wrong beep count plays. Debounce/settle window issues cause double-beeps for single events or single beeps for multiple events.
- **Hook delivery timeouts** (low, mitigated): Checkpoint capture blocks the hook response, causing CLI timeouts under load even when the transition succeeded.

## 10. Client-side project switch optimizations

Server-side latency for project switching has been addressed (metadata decoupled from snapshot, file reads parallelized, inactive project task counts cached). Preload-on-hover is done. Remaining client-side strategy to make switching feel instant:

- **Stale-while-revalidate**: Cache board state per project in memory. On switch, show the cached version immediately while fresh data loads. Requires careful gating of `canPersistWorkspaceState` and `workspaceRevision` to prevent stale data from being persisted back to disk.

## 11. Upstream sync: periodic review of cline/kanban (recurring)

Periodically review the upstream [cline/kanban](https://github.com/cline/kanban) project for recent bug fixes and improvements worth reimplementing. The codebase has diverged significantly (200+ commits, `cline-sdk/` removed entirely) so most changes need reimplementation rather than direct cherry-picks. Roughly half of upstream output is Cline SDK/account work that will never apply; the other half is shared UI/UX where ideas are portable even if code isn't.

**Cadence:** Check weekly-ish. Run `git fetch upstream && git log upstream/main --oneline --since="<last check date>"` and evaluate new commits.
**Tracker:** [docs/upstream-sync.md](upstream-sync.md) — living doc with Adopted / Backlog / Decided against sections. Update it after each review.

## 12. Audit CI/CD and deployment infrastructure

Review the existing GitHub Actions workflows (`ci.yml`, `test.yml`, `publish.yml`), issue templates, CODEOWNERS, and the changelog extraction script. Decide what's still relevant from the upstream fork, what needs updating (e.g. Slack webhook, CODEOWNERS), and whether anything is missing (e.g. automated changelog generation, release notes workflow).

## 13. Publish to npm

Register the `quarterdeck` package on npm, configure OIDC trusted publishing for the GitHub repo, and do the first publish via the existing `publish.yml` workflow. Once published, update the README install instructions to use `npx quarterdeck` / `npm i -g quarterdeck` instead of the current clone-and-build steps.

## 14. Git view compare tab doesn't refresh as the worktree advances

The compare tab fetches the diff once when opened and doesn't refetch as the agent commits. For named branches, the query key is `compare:feature-xyz:main` — it stays the same across commits, so no refetch fires. The comment at `git-view.tsx:335` says `// No polling for compare — branch diffs are stable` but this isn't true when the agent is actively working. Headless worktrees get this for free (headCommit changes on each commit, which changes the query key), but named branches don't. Include a changing signal (e.g. workspace snapshot headCommit or a state version) in the compare query key so the diff stays current while the agent works.

## 15. Archive stale docs (recurring)

Periodically read through docs in `docs/` (research, plans, specs, top-level) and archive anything that's for completed work. Clean up stale or outdated documents. Docs accumulate as features ship — this isn't a one-time task.

## 16. Revisit HTML chat view concept

The experimental HTML chat view (`terminalChatViewEnabled`) was removed because the implementation was incomplete and noisy — it stripped ANSI formatting and read from xterm's buffer, but output was unreliable for full-screen TUIs like Claude Code. Revisit the concept at some point: rendering agent output as styled HTML instead of a terminal canvas could enable better text selection, search, copy/paste, and accessibility. Would need a fundamentally different approach — likely parsing the agent's structured output (if available) rather than scraping the terminal buffer.
