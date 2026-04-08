# Dev Todo

## 1. Audit OS notification feature

The browser `Notification` API integration in `use-review-ready-notifications.ts` fires OS-level notifications when tasks move to review while the tab is hidden. Investigate whether this actually works reliably — test the permission flow, verify notifications appear on macOS, and decide whether to keep, improve, or remove it. The feature has a settings toggle (`readyForReviewNotificationsEnabled`) and permission request UI in the settings dialog.

## 2. Investigate auto-trashing of tasks on restart

When Quarterdeck is closed and reopened, all open tasks (in_progress, review) get moved to trash. Investigate whether this is a technical requirement (e.g. agent sessions can't be resumed so the tasks are considered dead) or just a UX decision that was made early and never revisited.

If it's not technically required, reconsider whether this makes sense — losing your board state on every restart is disruptive, especially for tasks that were waiting for review or had meaningful progress. This is closely related to #11 (resume sessions after crash/closure) but is worth investigating independently since keeping cards in place may be possible even if session resumption isn't.

## 3. Publish to npm

Register the `quarterdeck` package on npm, configure OIDC trusted publishing for the GitHub repo, and do the first publish via the existing `publish.yml` workflow. Once published, update the README install instructions to use `npx quarterdeck` / `npm i -g quarterdeck` instead of the current clone-and-build steps.

## 4. Audit CI/CD and deployment infrastructure

Review the existing GitHub Actions workflows (`ci.yml`, `test.yml`, `publish.yml`), issue templates, CODEOWNERS, and the changelog extraction script. Decide what's still relevant from the upstream fork, what needs updating (e.g. Slack webhook, CODEOWNERS), and whether anything is missing (e.g. automated changelog generation, release notes workflow).

## 5. Interactive base ref switcher

The diff toolbar shows the branch comparison (e.g. `feat/my-feature → main`) as a static label. Make this interactive — clicking the base ref should open a dropdown/popover to select a different branch to diff against, so users can compare their work against any branch, not just the original base ref.

Research and implementation plan at [docs/research/2026-04-07-interactive-diff-base-ref-switcher.md](research/2026-04-07-interactive-diff-base-ref-switcher.md) and [docs/plans/2026-04-07-interactive-diff-base-ref-switcher.md](plans/2026-04-07-interactive-diff-base-ref-switcher.md).

## 6. Unify task card behavior across views

The `BoardCard` component renders through two independent parent chains — the main board columns and the sidebar/context panel — and each threads props differently through intermediate components. Missing props silently disable features rather than erroring, which has already caused bugs (e.g. migrate button missing from sidebar cards). As more views are added (#9 project switcher), this divergence will get worse.

See [docs/research/2026-04-06-board-card-prop-threading-audit.md](research/2026-04-06-board-card-prop-threading-audit.md) for the full audit of current prop discrepancies between board and sidebar paths.

**Goals**:
- Audit and fix all current prop discrepancies between the board and sidebar rendering paths
- Future-proof so new views automatically get full card behavior without manual prop threading
- Consider a context-based approach (React context or a hook) so card callbacks don't need to be threaded through every intermediate component
- Ensure any new planned views (project switcher, decoupled sidebar) inherit full card interaction without per-view wiring

## 7. Server-side commit in the diff viewer

Add a real commit action to the Changes/diff panel — select files to stage, write a commit message, commit via server-side `runGit()`. No agent session required.

- **File selection**: The diff viewer already shows changed files in the file tree. Add checkboxes or a select-all toggle to choose which files to stage.
- **Commit message**: Inline text input in the diff panel. Auto-generate a default message from the task title and diff summary (changed file names, additions/deletions). Editable before committing.
- **Backend**: New tRPC mutation (e.g. `runtime.commitTaskChanges`) that stages selected files and commits in the task worktree using `runGit()`.
- **Scope**: This is the quick-commit flow for the common case — commit from the review you're already looking at. More complex git operations (merge, branch management) live in the git management view (#12), which would also support committing.

## 8. Pulse integration for enhanced status display (Nerd Fonts)

Integrate [Pulse](https://github.com/anthropics/pulse) — a Rust CLI tool that enhances the Claude Code status bar with rich glyphs — into Quarterdeck's terminal/status display when Nerd Fonts are detected.

**Investigation needed**:
- How Pulse works: is it a binary Quarterdeck shells out to, a library, or something that wraps the agent process?
- Where it would integrate: per-agent terminal status lines, a global Quarterdeck status bar, board card indicators, or some combination
- How to detect Nerd Fonts availability at runtime

**Requirements**:
- Auto-detect Nerd Fonts — if present, use Pulse-enhanced status display; if not, fall back to the current plain text display
- Should be seamless — no user configuration required beyond having Nerd Fonts installed
- Pulse is a tool made by a coworker, so coordinate with them on the integration surface

## 9. Project switcher in the detail toolbar

Add a project panel to the left detail toolbar (alongside the existing Board and Changes panels) for quickly jumping between projects without leaving the detail view. Adapt the existing project view from the main board into a compact sidebar format.

**Notification badges on projects**:
- **Orange badge (always on)**: Show when any task in that project is waiting for permissions — this is always important to surface.
- **Review badge (configurable per project)**: Optionally show when tasks are awaiting review. This is useful when actively working on multiple projects but noisy when a project is idle. Add a per-project toggle in the project panel to enable/disable review notifications.

**Implementation**: Take the existing project list/view from the main board and refactor it into a sidebar-compatible component for the detail toolbar panel slot.

## 10. Performance audit for concurrent agents

Audit and address performance bottlenecks that emerge when running many agents simultaneously. An earlier analysis exists at [docs/performance-bottleneck-analysis.md](performance-bottleneck-analysis.md) but is likely out of date — use it as a starting point, not a source of truth. Key areas to re-evaluate:

- State persistence lock contention under concurrent checkpoint writes
- WebSocket broadcast fan-out scaling with multiple agents and browser tabs
- Frontend memory growth (chat messages, terminal cache) over long sessions
- PTY output fanout and shared backpressure across viewers
- Large diffs cause noticeable UI lag — full file text (old + new) is sent inline and diff computation happens client-side, so tasks with many changed files or large files bog down the browser
- Profile real-world usage with 5–10 concurrent agents to identify any new bottlenecks introduced since the earlier analysis

## 11. Resume card sessions after crash/closure

When Quarterdeck crashes or is closed and reopened, clicking on existing cards no longer works — the Claude Code chat is unresponsive/broken. Need to:
- Investigate why the agent session doesn't reconnect after restart
- Ensure the correct worktree is switched to when resuming a card
- Resume or re-attach to the Claude conversation so the agent can continue where it left off
- Handle gracefully: if the old session can't be resumed, offer to start a fresh session in the same worktree/branch context

## 12. Git management / workspace view

A new detail sidebar panel for managing the main repository's state — branch switching, pulling, merging, and diffing branches. This view is not tied to any task; it operates on whatever is checked out in the main repo. The sidebar decoupling (previously #13) is now complete, enabling this work.

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

## 13. Incremental expand in diff viewer

Add "show 20 more lines" incremental expand buttons to collapsed context blocks in the diff viewer, replacing the current full-expand behavior with progressive expansion. This improves usability on large diffs where expanding all hidden lines at once is overwhelming.

Upstream cline/kanban implemented this in commit `56adf45a` — see [docs/upstream-sync-2026-04-08.md](upstream-sync-2026-04-08.md) for details. Our `diff-renderer.tsx` has diverged so this would need to be reimplemented rather than cherry-picked, but the upstream commit is a useful reference for the approach.

## 14. Investigate and fix orphaned processes

Runtime servers and hook ingest processes can get orphaned when their parent process (Cline, a terminal, etc.) exits without signaling shutdown. Observed in the wild: 4 zombie processes running for days, consuming CPU, and resisting SIGTERM (required SIGKILL).

Three issues to address:
- **No parent liveness detection**: The runtime has no way to know its parent died (no stdin EOF watch, no heartbeat). Investigate the existing IPC shutdown hook (`shutdown-ipc-hook.cjs`) — it didn't fire in the observed case.
- **Shutdown handler hangs on SIGTERM**: Both runtime servers spiked to high CPU on SIGTERM instead of exiting cleanly. The shutdown coordinator may block on stale filesystem state. Add timeouts and a hard exit deadline.
- **Hook ingest processes don't exit**: `hooks ingest` processes survived SIGTERM. They likely need their own timeout on the HTTP request to the runtime and proper signal handling.

Investigation doc at [docs/research/2026-04-08-orphaned-process-investigation.md](research/2026-04-08-orphaned-process-investigation.md).

## 15. Rewrite backend in Go

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

## 16. Fix: reset session button delay and functionality

The reset session button on task cards pops up too quickly and doesn't actually work when clicked. Two issues:
- Add a ~1 second delay before the button appears to avoid accidental clicks
- Investigate and fix whatever is broken in the reset session action itself

## 17. Diff sidebar notification for unmerged branch changes

The Changes icon in the sidebar currently only lights up for uncommitted changes. It should also indicate when the task branch has diverged from the base branch (i.e. unmerged changes exist). This surfaces "your branch has work that hasn't been merged back" without needing to open the diff viewer.

Consider making this a separate, non-red notification indicator on the sidebar icon, and optionally gating it behind a setting since it could be noisy for long-lived branches.

## 18. Archive remaining docs

Read through all leftover docs in `docs/` (research, plans, specs, top-level) and archive anything that's for completed work. Clean up stale or outdated documents.

## 19. Fix: audible notification double-beep and missed cues

Two related bugs with the notification audio system:
- Sometimes getting a double beep when only one should fire
- Sometimes getting 1 beep when 2 separate events should produce 2 beeps
- The settle/debounce window may be slightly too short, causing events to either merge when they shouldn't or fire twice when they should merge

## 20. Allow sidebar to resize past 50%

The detail sidebar currently can't be dragged past the halfway point of the viewport. Allow it to expand up to ~80% width for users who want a larger diff/file view without going full-screen.

## 21. File browser: preserve state between sidebar and full-size views

When switching from the sidebar file browser to the full-size view (or vice versa), the current file selection and expand/collapse state of the tree should be preserved. Currently the full-size view resets to a fresh state.

## 22. Add markdown renderer

Add a markdown renderer for viewing `.md` files in the file browser / file viewer. Currently markdown files are shown as raw text.

## 23. Investigate X button in file browser

The X button in the top-left of the file browser panel — what does it do? If it's unclear or non-functional, either fix it or remove it. If it's a close/dismiss action, make its purpose obvious.

## 24. Fix: project view task state indicators not staying up to date

The UI element in the project view that shows task state counts (how many tasks are in_progress, review, etc.) doesn't update in real-time when task states change. It likely needs to subscribe to WebSocket state updates or re-derive from the current board state.

## 25. File viewer: hide pop-out button when no file selected

In the file viewer panel, the file pop-out / open-externally button is visible even when no file is selected. Hide it when there's no active file selection.

## 26. Rate limiting and guardrails for automatic LLM calls

Add careful rate limiting as a guardrail for LLM calls that the user doesn't explicitly trigger — auto-generated titles, branch names, summaries, and other background LLM invocations. These should have sensible per-session and per-minute caps to prevent runaway API costs from bugs or rapid state transitions.

## 27. Bring back beta feedback popup

Re-add the floating feedback widget (previously removed during the rename/rebrand) as a small corner popup. This gives users a low-friction way to report issues or share feedback without navigating to GitHub.

## 28. Cherry-pick / land individual commits onto main from the UI

Add a UI action to land individual task commits (or a squashed commit) from a task worktree onto main without doing a full branch merge. This is the "ship this one thing" flow — you're reviewing a task's changes, you want to land them on main right now.

This is distinct from #7 (committing *within* the task worktree) and #12 (full git management with branch merging). This is a targeted "cherry-pick to main" action, likely surfaced as a button in the diff viewer or on the task card during review.

## 29. Notification badges on project sidebar for cross-project alerts

Add notification badges to the existing project sidebar icons to surface when tasks in other projects need attention — primarily permission prompts and review-ready states. This is a smaller, standalone version of the badge system described in #9 (project switcher) and should ship independently without requiring the full project panel redesign.

## 30. Upstream sync: check kanban project for cherry-pickable fixes

Review the upstream [kanban-org/kanban](https://github.com/kanban-org/kanban) project for recent bug fixes and improvements worth cherry-picking or reimplementing. The codebase has diverged significantly so most changes will need reimplementation rather than direct cherry-picks. See [docs/upstream-sync-2026-04-08.md](upstream-sync-2026-04-08.md) for the last sync review.
