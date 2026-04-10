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
- Port the agent adapter system (Claude, Codex, Gemini, OpenCode, Droid) — these are mostly CLI argument builders
- The research doc is organized module-by-module to support incremental porting

## 2. Resume card sessions after crash/closure

When Quarterdeck crashes or is closed and reopened, clicking on existing cards no longer works — the Claude Code chat is unresponsive/broken. Need to:
- Investigate why the agent session doesn't reconnect after restart
- Ensure the correct worktree is switched to when resuming a card
- Resume or re-attach to the Claude conversation so the agent can continue where it left off
- Handle gracefully: if the old session can't be resumed, offer to start a fresh session in the same worktree/branch context

## 3. Performance audit for concurrent agents

Audit and address performance bottlenecks that emerge when running many agents simultaneously. An earlier analysis exists at [docs/performance-bottleneck-analysis.md](performance-bottleneck-analysis.md) but is likely out of date — use it as a starting point, not a source of truth. Key areas to re-evaluate:

- State persistence lock contention under concurrent checkpoint writes
- WebSocket broadcast fan-out scaling with multiple agents and browser tabs
- Frontend memory growth (chat messages, terminal cache) over long sessions
- PTY output fanout and shared backpressure across viewers
- Large diffs cause noticeable UI lag — full file text (old + new) is sent inline and diff computation happens client-side, so tasks with many changed files or large files bog down the browser
- Profile real-world usage with 5–10 concurrent agents to identify any new bottlenecks introduced since the earlier analysis

## 4. Git management / workspace view

A new detail sidebar panel for managing the main repository's state — branch switching, pulling, merging, and diffing branches. This view is not tied to any task; it operates on whatever is checked out in the main repo. The sidebar decoupling is now complete, enabling this work.

**Branch management**:
- Show the currently checked out branch in the main repo (not a worktree)
- Switch branches (checkout) with a branch selector dropdown
- Pull from remote (with indicator when behind upstream)
- Merge branches — select a source branch to merge into the current branch
- Show recent commits on the current branch

**Branch diffing**:
- Select two branches to compare — opens the diff in the existing `DiffViewerPanel`
- This reuses the Changes panel infrastructure but with a different data source: `git diff branchA...branchB` instead of task workspace changes
- Requires a workspace-level data fetching path (e.g. a `getWorkspaceChangesBetweenRefs` call that isn't task-scoped)

**How it fits in the sidebar**:
- New toolbar button (e.g. `GitBranch` icon) adds a "Git" panel to `DetailPanelId`
- When the Git panel is active and a diff is requested, it populates the Changes panel with the branch diff — the two panels work together
- The main content area (where the terminal normally lives) could show a commit log, merge conflict resolution, or just an empty state

**Backend**:
- Most git operations already exist in `src/workspace/git-utils.ts` and `src/workspace/git-sync.ts` — branch listing, checkout, pull, diff between refs
- New tRPC mutations needed: `workspace.checkoutBranch`, `workspace.pullBranch`, `workspace.mergeBranch`
- New tRPC query: `workspace.getBranchList`, `workspace.getCurrentBranch`, `workspace.getBranchDiff` (wraps existing `getWorkspaceChangesBetweenRefs`)

**What this is NOT**: This is not a full Git GUI. It covers the common operations needed when orchestrating multiple agents — checking what's on main, pulling latest, merging completed task branches back, and diffing to verify. Complex operations (rebase, cherry-pick, conflict resolution) are out of scope.

## 5. Dual-selection sidebar rework (main view + sidebar)

Rework the sidebar toolbar from a single tab selection into two independent dimensions: **main view** (what fills the large content area) and **sidebar** (what fills the narrow left panel). Currently the toolbar conflates both — some tabs control the main area, others control the sidebar, and the user can't independently choose a combination.

Full spec at [docs/specs/2026-04-10-dual-selection-sidebar-rework.md](specs/2026-04-10-dual-selection-sidebar-rework.md). Key changes:
- Above divider: main view selectors (Home/board, Terminal, Files)
- Below divider: sidebar selectors (Projects, Board/task column, Changes/diff)
- Two independent state dimensions with auto-coupling rules (e.g., clicking a task → terminal main + task_column sidebar)
- Unify sidebar rendering at App.tsx level (currently split between App.tsx and CardDetailView)
- Extract agent terminal from CardDetailView into a standalone main view

**Depends on**: `feat/project-switcher-sidebar` (completed). Recommend 2-3 PRs: state/toolbar split → sidebar unification → terminal extraction.

## 6. Cherry-pick / land individual commits onto main from the UI

Add a UI action to land individual task commits (or a squashed commit) from a task worktree onto main without doing a full branch merge. This is the "ship this one thing" flow — you're reviewing a task's changes, you want to land them on main right now.

This is distinct from #12 (committing *within* the task worktree) and #4 (full git management with branch merging). This is a targeted "cherry-pick to main" action, likely surfaced as a button in the diff viewer or on the task card during review.

## 7. Upstream sync: periodic review of cline/kanban (recurring)

Periodically review the upstream [cline/kanban](https://github.com/cline/kanban) project for recent bug fixes and improvements worth reimplementing. The codebase has diverged significantly (200+ commits, `cline-sdk/` removed entirely) so most changes need reimplementation rather than direct cherry-picks. Roughly half of upstream output is Cline SDK/account work that will never apply; the other half is shared UI/UX where ideas are portable even if code isn't.

**Cadence:** Check weekly-ish. Run `git fetch upstream && git log upstream/main --oneline --since="<last check date>"` and evaluate new commits.
**Tracker:** [docs/upstream-sync.md](upstream-sync.md) — living doc with Adopted / Backlog / Decided against sections. Update it after each review.

## 8. Audit CI/CD and deployment infrastructure

Review the existing GitHub Actions workflows (`ci.yml`, `test.yml`, `publish.yml`), issue templates, CODEOWNERS, and the changelog extraction script. Decide what's still relevant from the upstream fork, what needs updating (e.g. Slack webhook, CODEOWNERS), and whether anything is missing (e.g. automated changelog generation, release notes workflow).

## 9. Investigate auto-trashing of tasks on restart

When Quarterdeck is closed and reopened, all open tasks (in_progress, review) get moved to trash. Investigate whether this is a technical requirement (e.g. agent sessions can't be resumed so the tasks are considered dead) or just a UX decision that was made early and never revisited.

If it's not technically required, reconsider whether this makes sense — losing your board state on every restart is disruptive, especially for tasks that were waiting for review or had meaningful progress. This is closely related to #2 (resume sessions after crash/closure) but is worth investigating independently since keeping cards in place may be possible even if session resumption isn't.

## 10. Investigate un-trash / restart paths for non-isolated worktrees

Investigate what happens on the un-trash and session restart code paths for tasks that are **not** using isolated git worktrees. Specifically:

- How does branch resume work when there's no dedicated worktree to switch back to?
- Does un-trashing a non-worktree task correctly restore the branch context, or does it leave the task in a broken state?
- Does the restart/reset session button handle non-worktree tasks, or does it assume a worktree exists?
- What git state is cleaned up on trash for non-worktree tasks vs worktree tasks, and can that be reversed on un-trash?

This is about ensuring the full trash → un-trash → resume cycle works for both execution modes, not just isolated worktrees.

## 11. Publish to npm

Register the `quarterdeck` package on npm, configure OIDC trusted publishing for the GitHub repo, and do the first publish via the existing `publish.yml` workflow. Once published, update the README install instructions to use `npx quarterdeck` / `npm i -g quarterdeck` instead of the current clone-and-build steps.

## 12. Server-side commit in the diff viewer

Add a real commit action to the Changes/diff panel — select files to stage, write a commit message, commit via server-side `runGit()`. No agent session required.

- **File selection**: The diff viewer already shows changed files in the file tree. Add checkboxes or a select-all toggle to choose which files to stage.
- **Commit message**: Inline text input in the diff panel. Auto-generate a default message from the task title and diff summary (changed file names, additions/deletions). Editable before committing.
- **Backend**: New tRPC mutation (e.g. `runtime.commitTaskChanges`) that stages selected files and commits in the task worktree using `runGit()`.
- **Scope**: This is the quick-commit flow for the common case — commit from the review you're already looking at. More complex git operations (merge, branch management) live in the git management view (#4), which would also support committing.

## 13. Interactive base ref switcher

The diff toolbar shows the branch comparison (e.g. `feat/my-feature → main`) as a static label. Make this interactive — clicking the base ref should open a dropdown/popover to select a different branch to diff against, so users can compare their work against any branch, not just the original base ref.

Research and implementation plan at [docs/research/2026-04-07-interactive-diff-base-ref-switcher.md](research/2026-04-07-interactive-diff-base-ref-switcher.md) and [docs/plans/2026-04-07-interactive-diff-base-ref-switcher.md](plans/2026-04-07-interactive-diff-base-ref-switcher.md).

## 14. Fix: notification beep count wrong for rapid state transitions

When a task goes to "ready for review" then quickly switches to "needs input", only 1 beep plays instead of 2. Also, "waiting for approval" may always be playing only 1 beep regardless of config. This may overlap with #15 (double-beep / missed cues) — check the implementation log, as a recent fix may have partially addressed this.

## 15. Fix: audible notification double-beep and missed cues

Two related bugs with the notification audio system:
- Sometimes getting a double beep when only one should fire
- Sometimes getting 1 beep when 2 separate events should produce 2 beeps
- The settle/debounce window may be slightly too short, causing events to either merge when they shouldn't or fire twice when they should merge

## 16. Add markdown renderer

Add a markdown renderer for viewing `.md` files in the file browser / file viewer. Currently markdown files are shown as raw text.

## 17. Reorder settings menu

The settings dialog sections/items aren't in an intuitive order. Reorganize them so the most commonly used settings are near the top and related settings are grouped logically.

## 18. Decouple session summary dual-sourcing between terminal and state layers

The terminal layer (`TerminalSessionManager`) owns session summaries in memory, but the state/persistence layer reads them back via `listSummaries()` to persist. This creates a one-directional but tight coupling between 7 files. The TRPC layer also makes direct mutation calls into the terminal layer (10+ methods on the public surface).

**Context**: Research doc at [docs/research/2026-04-10-session-summary-dual-sourcing.md](research/2026-04-10-session-summary-dual-sourcing.md) covers the full data flow, files involved, and three decoupling options.

**Recommendation**: If the Go rewrite (#1) happens soon, design the session store correctly from the start — the current coupling maps cleanly to a Go interface. If TypeScript needs to live longer, extract a `SessionSummaryStore` service (~2-3 days).

## 19. Archive stale docs (recurring)

Periodically read through docs in `docs/` (research, plans, specs, top-level) and archive anything that's for completed work. Clean up stale or outdated documents. Docs accumulate as features ship — this isn't a one-time task.

## 20. Move agent chat out of the project switcher sidebar

The agent chat UI currently lives inside the project switcher sidebar tab. It doesn't belong there — the project switcher should be focused on project selection and status. Extract the agent chat into its own location. The right destination is TBD — could be its own sidebar tab, a main view, a panel, or something else. Investigate where it fits best in the existing layout before committing to a placement.

## 21. Slow project switching — cache or preload board state

Switching projects has a noticeable delay because the board tasks take a moment to load after the switch. Investigate caching strategies to make project switching feel instant — e.g. keeping the previous project's board state in memory, preloading the target project's state in the background when hovering or when the project switcher is open, or caching the last-known board state client-side so it can render immediately while fresh data loads behind it.

## 22. Independent sidebar widths per panel type (post diff rewrite)

The sidebar width is currently shared across all panel types — the task column, project switcher, and git diff sidebar all use the same width. These panels have different content density and ideal widths, so resizing one shouldn't affect the others. Store and restore sidebar width independently per panel type (e.g. task column, project switcher, changes/diff) so each remembers its own preferred width. This should be done after the diff viewer rewrite lands.

## 23. Un-trashing shared-workspace tasks clobbers session state

When un-trashing tasks that share the main repo (no isolated worktree), the restore logic reattaches to the most recent agent chat session rather than the original session that belonged to that task. This means un-trashing multiple shared-workspace tasks doesn't work — each subsequent un-trash steals the session from the previously restored task, and any external agent session started in the same workspace will replace it too. The root issue is that shared-workspace tasks all compete for a single "current session" with no per-task session scoping. Needs a way to associate and restore the correct session per task, even when they share a workspace.

Related: #10 (un-trash / restart paths for non-isolated worktrees).

## 24. Un-trash doesn't always auto-resume the agent session

After un-trashing a task, the terminal sometimes shows the original prompt but not the rest of the conversation context — the agent session isn't fully restored. Manually typing `/resume` in the terminal works and brings back the full session. Investigate why auto-resume doesn't reliably trigger on un-trash and ensure the full session context is restored automatically. Observed primarily with isolated worktree tasks but may affect shared-workspace tasks too.

Related: #2 (resume sessions after crash/closure), #10 (un-trash / restart paths for non-isolated worktrees).

## 25. Task stuck in "running" when agent is waiting for permission

A task can appear as running/in-progress on the board when the agent is actually blocked waiting for user permission approval. There's no distinction in the UI between "agent is actively working" and "agent is paused waiting for permission input." Investigate detecting when an agent is in a permission prompt state and surface it on the board — either as a distinct card status, a visual indicator on the running card, or a notification so the user knows action is needed.

## 26. Delayed transition to "running" state on prompt submission

When sending a prompt to an agent, the task card doesn't always move to the running/in-progress state right away. It appears to stay in its previous state during the agent's initial thinking phase, then transitions on what looks like a second burst of activity. Investigate the hook or state transition trigger — it may be keying off a terminal output pattern that doesn't match the agent's first response, or there's a debounce/settle delay that's too long. The transition should happen as soon as the prompt is submitted or the agent begins processing, not after a noticeable delay.

Related: #25 (agent state detection issues).

## 27. Reorder projects in the project switcher

The project list in the project switcher sidebar has no way to reorder entries. Add drag-and-drop or manual reordering so users can arrange projects in their preferred order. Persist the ordering across sessions.

