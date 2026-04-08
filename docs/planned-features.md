# Planned Features

## 1. Fix: slight lag on audible notifications

The sound notifications have a noticeable delay before playing. Likely caused by the 1500ms settle window in `use-audible-notifications.ts` that waits for session data to stabilize. May need to reduce or eliminate the delay for high-priority events like permission requests.

## 2. Unify LLM generation UI and disabled states

The LLM-powered generation features (branch name, title, display summary) use inconsistent icons and don't grey out when LLM generation is disabled or unconfigured.

**Current inconsistencies**:
- Branch name generation uses `Sparkles` icon (`task-create-dialog.tsx`)
- Title generation uses `RefreshCw` icon (`inline-title-editor.tsx`)
- Display summary generation is triggered on hover with no direct button

**Changes**:
- Pick a single icon for all LLM generation actions and use it consistently
- Grey out / disable all LLM generation buttons when generation is disabled in settings or no API key / model is configured
- Audit the code paths to ensure they share a clean pattern (e.g. a shared hook or config check for "is LLM generation available")

## 3. Move shortcut button out of task cards

**Status**: Implemented. Prompt shortcut split button moved from per-card rendering to a single TopBar instance, gated on task selection. Removed 6-prop threading chain through CardDetailView → ColumnContextPanel → ColumnSection → BoardCard.

## 4. Fix: branch name cleared on trashed task cards

The persisted `branch` field on cards is sometimes getting cleared when the card is in the trash column. `reconcileTaskBranch` guards against overwriting a non-null branch with null, and `moveTaskToColumn` doesn't touch the branch field, so the clearing is happening through some other path. Needs investigation.

## 5. Audit OS notification feature

The browser `Notification` API integration in `use-review-ready-notifications.ts` fires OS-level notifications when tasks move to review while the tab is hidden. Investigate whether this actually works reliably — test the permission flow, verify notifications appear on macOS, and decide whether to keep, improve, or remove it. The feature has a settings toggle (`readyForReviewNotificationsEnabled`) and permission request UI in the settings dialog.

## 6. Investigate auto-trashing of tasks on restart

When Quarterdeck is closed and reopened, all open tasks (in_progress, review) get moved to trash. Investigate whether this is a technical requirement (e.g. agent sessions can't be resumed so the tasks are considered dead) or just a UX decision that was made early and never revisited.

If it's not technically required, reconsider whether this makes sense — losing your board state on every restart is disruptive, especially for tasks that were waiting for review or had meaningful progress. This is closely related to #15 (resume sessions after crash/closure) but is worth investigating independently since keeping cards in place may be possible even if session resumption isn't.

## 7. Shared config test fixtures to eliminate merge conflicts

Consolidate the ~10 copy-pasted config mock factories across test files into 2 shared factory files (one backend, one web-ui). Currently adding a single config field forces changes to ~12 test files with hardcoded mock objects, making parallel feature branches a merge conflict magnet. Plan at [docs/plans/2026-04-07-shared-config-test-fixtures.md](plans/2026-04-07-shared-config-test-fixtures.md).

## 8. Interactive base ref switcher

The diff toolbar shows the branch comparison (e.g. `feat/my-feature → main`) as a static label. Make this interactive — clicking the base ref should open a dropdown/popover to select a different branch to diff against, so users can compare their work against any branch, not just the original base ref.

Research and implementation plan at [docs/research/2026-04-07-interactive-diff-base-ref-switcher.md](research/2026-04-07-interactive-diff-base-ref-switcher.md) and [docs/plans/2026-04-07-interactive-diff-base-ref-switcher.md](plans/2026-04-07-interactive-diff-base-ref-switcher.md).

## 9. Unify task card behavior across views

The `BoardCard` component renders through two independent parent chains — the main board columns and the sidebar/context panel — and each threads props differently through intermediate components. Missing props silently disable features rather than erroring, which has already caused bugs (e.g. migrate button missing from sidebar cards). As more views are added (#13 project switcher, #16 sidebar decoupling), this divergence will get worse.

See [docs/research/2026-04-06-board-card-prop-threading-audit.md](research/2026-04-06-board-card-prop-threading-audit.md) for the full audit of current prop discrepancies between board and sidebar paths.

**Goals**:
- Audit and fix all current prop discrepancies between the board and sidebar rendering paths
- Future-proof so new views automatically get full card behavior without manual prop threading
- Consider a context-based approach (React context or a hook) so card callbacks don't need to be threaded through every intermediate component
- Ensure any new planned views (project switcher, decoupled sidebar) inherit full card interaction without per-view wiring

## 10. Self-healing for stale task status indicators

UI status indicators like "needs perms" and "waiting for approval" can get stuck when the underlying agent state changes in ways the UI doesn't catch — e.g. hitting Escape on a permission prompt dismisses it in the agent but the card still shows "waiting for approval". Add a periodic reconciliation job that polls actual agent/session state and corrects stale UI badges. This should cover at minimum:
- Permission/approval badges that linger after the prompt is dismissed or resolved
- Any status badge that outlives the session state it was derived from
- Consider a heartbeat or terminal output heuristic — if the agent is producing new output, it's clearly not blocked on permissions anymore

## 11. Server-side commit in the diff viewer

Add a real commit action to the Changes/diff panel — select files to stage, write a commit message, commit via server-side `runGit()`. No agent session required.

- **File selection**: The diff viewer already shows changed files in the file tree. Add checkboxes or a select-all toggle to choose which files to stage.
- **Commit message**: Inline text input in the diff panel. Auto-generate a default message from the task title and diff summary (changed file names, additions/deletions). Editable before committing.
- **Backend**: New tRPC mutation (e.g. `runtime.commitTaskChanges`) that stages selected files and commits in the task worktree using `runGit()`.
- **Scope**: This is the quick-commit flow for the common case — commit from the review you're already looking at. More complex git operations (merge, branch management) live in the git management view (#17), which would also support committing.

## 12. Pulse integration for enhanced status display (Nerd Fonts)

Integrate [Pulse](https://github.com/anthropics/pulse) — a Rust CLI tool that enhances the Claude Code status bar with rich glyphs — into Quarterdeck's terminal/status display when Nerd Fonts are detected.

**Investigation needed**:
- How Pulse works: is it a binary Quarterdeck shells out to, a library, or something that wraps the agent process?
- Where it would integrate: per-agent terminal status lines, a global Quarterdeck status bar, board card indicators, or some combination
- How to detect Nerd Fonts availability at runtime

**Requirements**:
- Auto-detect Nerd Fonts — if present, use Pulse-enhanced status display; if not, fall back to the current plain text display
- Should be seamless — no user configuration required beyond having Nerd Fonts installed
- Pulse is a tool made by a coworker, so coordinate with them on the integration surface

## 13. Project switcher in the detail toolbar

Add a project panel to the left detail toolbar (alongside the existing Board and Changes panels) for quickly jumping between projects without leaving the detail view. Adapt the existing project view from the main board into a compact sidebar format.

**Notification badges on projects**:
- **Orange badge (always on)**: Show when any task in that project is waiting for permissions — this is always important to surface.
- **Review badge (configurable per project)**: Optionally show when tasks are awaiting review. This is useful when actively working on multiple projects but noisy when a project is idle. Add a per-project toggle in the project panel to enable/disable review notifications.

**Implementation**: Take the existing project list/view from the main board and refactor it into a sidebar-compatible component for the detail toolbar panel slot.

## 14. Performance audit for concurrent agents

Audit and address performance bottlenecks that emerge when running many agents simultaneously. An earlier analysis exists at [docs/performance-bottleneck-analysis.md](performance-bottleneck-analysis.md) but is likely out of date — use it as a starting point, not a source of truth. Key areas to re-evaluate:

- State persistence lock contention under concurrent checkpoint writes
- WebSocket broadcast fan-out scaling with multiple agents and browser tabs
- Frontend memory growth (chat messages, terminal cache) over long sessions
- PTY output fanout and shared backpressure across viewers
- Large diffs cause noticeable UI lag — full file text (old + new) is sent inline and diff computation happens client-side, so tasks with many changed files or large files bog down the browser
- Profile real-world usage with 5–10 concurrent agents to identify any new bottlenecks introduced since the earlier analysis

## 15. Resume card sessions after crash/closure

When Quarterdeck crashes or is closed and reopened, clicking on existing cards no longer works — the Claude Code chat is unresponsive/broken. Need to:
- Investigate why the agent session doesn't reconnect after restart
- Ensure the correct worktree is switched to when resuming a card
- Resume or re-attach to the Claude conversation so the agent can continue where it left off
- Handle gracefully: if the old session can't be resumed, offer to start a fresh session in the same worktree/branch context

## 16. Decouple the detail sidebar from task selection

The detail sidebar (left toolbar + panel slots + resize layout) is currently only rendered when a task is selected via `CardDetailView`, which requires a `CardSelection` prop. This blocks using the sidebar for non-task views like git management, a standalone board panel, or workspace-level browsing.

**What's already decoupled (no work needed)**:
- `DetailToolbar` — purely panel switching + badge, zero task references
- `useCardDetailLayout` hook — generic layout state (panel ratios, active panel, resize preferences)
- `ResizeHandle` / `useResizeDrag` — completely generic

**What needs decoupling**:
- `CardDetailView` is the outer shell — it requires `CardSelection` and threads `selection.card.id` through 20+ child references. Refactor to accept an optional task selection. When no task is selected, the sidebar still renders with panels appropriate to the context.
- `DiffViewerPanel` and `FileTreePanel` are already data-driven (they receive `workspaceFiles`, not a task ID), so they work without a task as long as the data source changes.
- `FileBrowserPanel` explicitly takes `taskId` and `baseRef` — needs to accept a generic workspace/directory context instead.
- `AgentTerminalPanel` requires a task ID — when no task is selected, the main content area should render an alternate view (workspace terminal, empty state, or whatever panel is active).
- Workspace data fetching (`useRuntimeWorkspaceChanges`, `useTaskWorkspaceInfoValue`, etc.) is task-keyed — needs a parallel code path for workspace-level data (e.g. changes on the main repo's current branch).

**Approach**: Rather than a full architectural rewrite, introduce a `DetailContext` concept — either "task" (existing behavior, includes card + session) or "workspace" (no task, operates on the main repo). `CardDetailView` switches its data sources and available panels based on context. The toolbar, layout, and resize system stay exactly as-is.

**Long-term direction**: This is the enabling work for making the sidebar the primary navigation surface. The board view, git management, project switcher, and task detail would all be views composed within the same sidebar shell. See #17 (git management) and #13 (project switcher) as the first consumers of this decoupled sidebar.

**Board view as a sidebar tab**: When moving the board into the sidebar, also reconsider the column stages themselves — are backlog/in_progress/review/done/trash still the right model, or should stages be more flexible? At minimum, update the colors for in_progress and review — they're too similar and hard to distinguish at a glance in a compact sidebar layout.

## 17. Git management / workspace view

A new detail sidebar panel for managing the main repository's state — branch switching, pulling, merging, and diffing branches. This view is not tied to any task; it operates on whatever is checked out in the main repo. Depends on #16 (decoupled sidebar) for rendering without a task selection.

**Branch management**:
- Show the currently checked out branch in the main repo (not a worktree)
- Switch branches (checkout) with a branch selector dropdown
- Pull from remote (with indicator when behind upstream)
- Merge branches — select a source branch to merge into the current branch
- Show recent commits on the current branch

**Branch diffing**:
- Select two branches to compare — opens the diff in the existing `DiffViewerPanel`
- This reuses the Changes panel infrastructure but with a different data source: `git diff branchA...branchB` instead of task workspace changes
- Requires the workspace-level data fetching path from #16 (e.g. a `getWorkspaceChangesBetweenRefs` call that isn't task-scoped)

**How it fits in the sidebar**:
- New toolbar button (e.g. `GitBranch` icon) adds a "Git" panel to `DetailPanelId`
- When the Git panel is active and a diff is requested, it populates the Changes panel with the branch diff — the two panels work together
- The main content area (where the terminal normally lives) could show a commit log, merge conflict resolution, or just an empty state

**Backend**:
- Most git operations already exist in `src/workspace/git-utils.ts` and `src/workspace/git-sync.ts` — branch listing, checkout, pull, diff between refs
- New tRPC mutations needed: `workspace.checkoutBranch`, `workspace.pullBranch`, `workspace.mergeBranch`
- New tRPC query: `workspace.getBranchList`, `workspace.getCurrentBranch`, `workspace.getBranchDiff` (wraps existing `getWorkspaceChangesBetweenRefs`)

**What this is NOT**: This is not a full Git GUI. It covers the common operations needed when orchestrating multiple agents — checking what's on main, pulling latest, merging completed task branches back, and diffing to verify. Complex operations (rebase, cherry-pick, conflict resolution) are out of scope.

## 18. Rewrite backend in Go

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
