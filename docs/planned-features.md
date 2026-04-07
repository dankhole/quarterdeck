# Planned Features

## 1. Resume card sessions after crash/closure

When Quarterdeck crashes or is closed and reopened, clicking on existing cards no longer works — the Claude Code chat is unresponsive/broken. Need to:
- Investigate why the agent session doesn't reconnect after restart
- Ensure the correct worktree is switched to when resuming a card
- Resume or re-attach to the Claude conversation so the agent can continue where it left off
- Handle gracefully: if the old session can't be resumed, offer to start a fresh session in the same worktree/branch context

## 2. Configurable "move to trash" behavior

When trashing a card, allow customizing whether the associated worktree is automatically deleted:
- Add a setting (per-project or global) to auto-delete the worktree when trashing a card
- Lost work is acceptable — this is a conscious choice for keeping things clean
- **Always** show a warning/confirmation dialog before trashing, regardless of the setting
- The warning should clearly state what will happen (e.g. "This will delete the worktree and any uncommitted changes")

## 3. Branch persistence on cards

Persist the working branch on the card itself so it survives restarts and worktree cleanup. Currently the branch is only stored in transient workspace metadata (`RuntimeTaskWorkspaceMetadata`) which is session-only — it does not survive restarts or worktree cleanup. The `BoardCard` / `runtimeBoardCardSchema` types need a `branch` field added and persisted to workspace state. See [docs/worktree-cwd-drift-detection.md](worktree-cwd-drift-detection.md) for full writeup.

## 4. Interactive base ref switcher

The diff toolbar shows the branch comparison (e.g. `feat/my-feature → main`) as a static label. Make this interactive — clicking the base ref should open a dropdown/popover to select a different branch to diff against, so users can compare their work against any branch, not just the original base ref.

Research and implementation plan at [docs/research/2026-04-07-interactive-diff-base-ref-switcher.md](research/2026-04-07-interactive-diff-base-ref-switcher.md) and [docs/plans/2026-04-07-interactive-diff-base-ref-switcher.md](plans/2026-04-07-interactive-diff-base-ref-switcher.md).

## 5. Remove commit and PR prompt injection buttons

The commit and create PR buttons on board cards, sidebar cards, and the agent terminal panel are purely prompt injection — they build a template string (e.g. "Handle this commit action using the provided git context") and paste it into the agent's terminal via `sendTaskSessionInput`. No actual git commands are executed. The agent is entirely responsible for interpreting the prompt and running git operations, which makes these buttons strictly worse than skills (which do the same thing but are user-configurable and context-aware).

**What to remove**:
- Commit button from board cards (board view and sidebar/context panel), and the agent terminal panel
- Create PR button from the same locations
- The `commitPromptTemplate` and `openPrPromptTemplate` settings and their configuration UI
- The `use-git-actions.ts` hook and `build-task-git-action-prompt.ts` prompt builder
- Related loading states (`isCommitLoading`, `isOpenPrLoading`) and callbacks threaded through components

**Layout change**: With the commit/PR buttons removed from the agent terminal panel, the terminal should expand to fill the full space they occupied. No dead space left behind.

**Rationale**: These buttons give the impression of real git integration when they're just typing into the terminal. Real git operations belong in the diff viewer (#6) and git management view (#10). Anyone who wants prompt-injection-style commit/PR can set up a skill for it.

## 6. Server-side commit in the diff viewer

Add a real commit action to the Changes/diff panel — select files to stage, write a commit message, commit via server-side `runGit()`. No agent session required.

- **File selection**: The diff viewer already shows changed files in the file tree. Add checkboxes or a select-all toggle to choose which files to stage.
- **Commit message**: Inline text input in the diff panel. Auto-generate a default message from the task title and diff summary (changed file names, additions/deletions). Editable before committing.
- **Backend**: New tRPC mutation (e.g. `runtime.commitTaskChanges`) that stages selected files and commits in the task worktree using `runGit()`.
- **Scope**: This is the quick-commit flow for the common case — commit from the review you're already looking at. More complex git operations (merge, branch management) live in the git management view (#10), which would also support committing.

## 6. Performance audit for concurrent agents

Audit and address performance bottlenecks that emerge when running many agents simultaneously. An earlier analysis exists at [docs/performance-bottleneck-analysis.md](performance-bottleneck-analysis.md) but is likely out of date — use it as a starting point, not a source of truth. Key areas to re-evaluate:

- State persistence lock contention under concurrent checkpoint writes
- WebSocket broadcast fan-out scaling with multiple agents and browser tabs
- Frontend memory growth (chat messages, terminal cache) over long sessions
- PTY output fanout and shared backpressure across viewers
- Large diffs cause noticeable UI lag — full file text (old + new) is sent inline and diff computation happens client-side, so tasks with many changed files or large files bog down the browser
- Profile real-world usage with 5–10 concurrent agents to identify any new bottlenecks introduced since the earlier analysis

## 7. Create task dialog: shortcut remap and discoverability

The create task dialog currently has "Start task" and "Start and open" as a toggling dropdown, but the dropdown is easy to miss — it's not obvious that "Start and open" exists as an option.

**Remap keyboard shortcuts** to better reflect usage priority:
- `Cmd+Enter` → **Start task** (was "Create")
- `Cmd+Shift+Enter` → **Start and open** (was "Start task")
- `Cmd+Alt+Enter` → **Create only** (demoted, least common action)

**Improve discoverability of "Start and open"**: Make it more visually obvious that the start button has multiple actions — the current dropdown affordance is too subtle. Consider a more visible split-button design or always showing both options.

## 8. Project switcher in the detail toolbar

Add a project panel to the left detail toolbar (alongside the existing Board and Changes panels) for quickly jumping between projects without leaving the detail view. Adapt the existing project view from the main board into a compact sidebar format.

**Notification badges on projects**:
- **Orange badge (always on)**: Show when any task in that project is waiting for permissions — this is always important to surface.
- **Review badge (configurable per project)**: Optionally show when tasks are awaiting review. This is useful when actively working on multiple projects but noisy when a project is idle. Add a per-project toggle in the project panel to enable/disable review notifications.

**Implementation**: Take the existing project list/view from the main board and refactor it into a sidebar-compatible component for the detail toolbar panel slot.

## 9. Decouple the detail sidebar from task selection

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

**Long-term direction**: This is the enabling work for making the sidebar the primary navigation surface. The board view, git management, project switcher, and task detail would all be views composed within the same sidebar shell. See #10 (git management) and #8 (project switcher) as the first consumers of this decoupled sidebar.

**Board view as a sidebar tab**: When moving the board into the sidebar, also reconsider the column stages themselves — are backlog/in_progress/review/done/trash still the right model, or should stages be more flexible? At minimum, update the colors for in_progress and review — they're too similar and hard to distinguish at a glance in a compact sidebar layout.

## 10. Git management / workspace view

A new detail sidebar panel for managing the main repository's state — branch switching, pulling, merging, and diffing branches. This view is not tied to any task; it operates on whatever is checked out in the main repo. Depends on #9 (decoupled sidebar) for rendering without a task selection.

**Branch management**:
- Show the currently checked out branch in the main repo (not a worktree)
- Switch branches (checkout) with a branch selector dropdown
- Pull from remote (with indicator when behind upstream)
- Merge branches — select a source branch to merge into the current branch
- Show recent commits on the current branch

**Branch diffing**:
- Select two branches to compare — opens the diff in the existing `DiffViewerPanel`
- This reuses the Changes panel infrastructure but with a different data source: `git diff branchA...branchB` instead of task workspace changes
- Requires the workspace-level data fetching path from #9 (e.g. a `getWorkspaceChangesBetweenRefs` call that isn't task-scoped)

**How it fits in the sidebar**:
- New toolbar button (e.g. `GitBranch` icon) adds a "Git" panel to `DetailPanelId`
- When the Git panel is active and a diff is requested, it populates the Changes panel with the branch diff — the two panels work together
- The main content area (where the terminal normally lives) could show a commit log, merge conflict resolution, or just an empty state

**Backend**:
- Most git operations already exist in `src/workspace/git-utils.ts` and `src/workspace/git-sync.ts` — branch listing, checkout, pull, diff between refs
- New tRPC mutations needed: `workspace.checkoutBranch`, `workspace.pullBranch`, `workspace.mergeBranch`
- New tRPC query: `workspace.getBranchList`, `workspace.getCurrentBranch`, `workspace.getBranchDiff` (wraps existing `getWorkspaceChangesBetweenRefs`)

**What this is NOT**: This is not a full Git GUI. It covers the common operations needed when orchestrating multiple agents — checking what's on main, pulling latest, merging completed task branches back, and diffing to verify. Complex operations (rebase, cherry-pick, conflict resolution) are out of scope.

## 11. Pulse integration for enhanced status display (Nerd Fonts)

Integrate [Pulse](https://github.com/anthropics/pulse) — a Rust CLI tool that enhances the Claude Code status bar with rich glyphs — into Quarterdeck's terminal/status display when Nerd Fonts are detected.

**Investigation needed**:
- How Pulse works: is it a binary Quarterdeck shells out to, a library, or something that wraps the agent process?
- Where it would integrate: per-agent terminal status lines, a global Quarterdeck status bar, board card indicators, or some combination
- How to detect Nerd Fonts availability at runtime

**Requirements**:
- Auto-detect Nerd Fonts — if present, use Pulse-enhanced status display; if not, fall back to the current plain text display
- Should be seamless — no user configuration required beyond having Nerd Fonts installed
- Pulse is a tool made by a coworker, so coordinate with them on the integration surface

## 12. Rename and rebrand as a fork

This project is a fork of [kanban-org/kanban](https://github.com/kanban-org/kanban) that has been progressively diverging with significant new features and architectural changes. It currently still carries the original name, repo references, and npm package identity. Need to:

- **Rename the project** — pick a new name that reflects the new direction (light AI IDE, multi-agent orchestration, terminal-centric — quarterdeck is just one view). Available on npm:
  - **Braid** — braiding parallel agent threads into a cohesive result. Short, memorable, `npx braid` reads well. **Frontrunner.**
  - **Quarterdeck** — the command deck of a ship. Strong metaphor for orchestration. Longer, but distinctive and `npx quarterdeck` has presence.
  - **Cupola** — an observation dome. Distinctive, evokes overseeing agents from above.
  - **Tackboard** — compound, available but sounds like a physical object.
  - **Loomboard** — compound, available but less punchy.
- **Update package.json** — new name, author/contact info, repository URL pointing to the fork
- **Update CLAUDE.md** — currently says "Published to npm as `npx quarterdeck`. Repository: https://github.com/dankhole/quarterdeck" which is the upstream, not this fork
- **Add attribution** — clearly state in README and package metadata that this was forked from kanban-org/kanban and that much of the foundational work is theirs
- **Update CI/CD** — publish.yml references the upstream npm package and Slack webhook; update for the new identity
- **Consider npm scope** — publish under a scoped package name (e.g. `@dcole/quarterdeck` or the new project name) to avoid conflicts with the upstream package

## 13. Rewrite backend in Go

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

## 14. Configurable audible notifications

Play a sound when tasks need attention so you don't have to keep watching the board. Should be configurable per event type and globally toggle-able.

**Events that could trigger sounds**:
- Task waiting for permissions (highest priority — blocks progress)
- Task moved to review / awaiting review
- Task failed or session died
- Task completed successfully

**Configuration**:
- Global on/off toggle in settings
- Per-event-type enable/disable (e.g. sound on permissions but not on review)
- Volume control or at minimum a way to pick between a few built-in sounds (subtle chime vs more urgent alert)

**Implementation options**:
- **Browser-side**: Use the Web Audio API or `<audio>` element to play sounds from the frontend. Simplest approach — no backend changes needed, works with built-in or bundled sound files. Requires the browser tab to be open.
- **System-side**: Use the backend to trigger OS-level sounds (e.g. `afplay` on macOS, `paplay` on Linux). Works even if the browser tab is backgrounded/closed, but platform-specific.
- Could support both — browser audio as default, with an opt-in setting for system-level notifications (pairs well with OS notification integration if added later)

## 16. Quick actions menu for stored prompts / skill calls (low priority)

A configurable dropdown or palette in the agent terminal panel for firing stored prompts or skill invocations at the active agent. This would partially replace the removed commit/PR buttons (#5) with something user-configurable rather than hardcoded.

**Open question**: This might not be worth building. Typing a skill call or prompt directly into the terminal is already fast, and a dropdown adds UI complexity for marginal convenience. Worth noting as a possibility but not urgent.

**If built**:
- Dropdown or command palette accessible from the terminal panel toolbar
- User-configurable list of entries — each is either a stored prompt template or a skill invocation
- Entries can interpolate task context (branch name, base ref, task title) like the old commit prompt templates did
- Per-project and global entries
- Could also support keyboard shortcuts per entry for power users

## 17. Task conversation summaries and improved title generation

Capture a lightweight conversation summary when agents transition tasks (e.g. move to review), and use it to improve the auto-generated task titles which are currently pretty bad.

A research doc exists at [docs/research/2026-04-06-task-conversation-summary-approaches.md](research/2026-04-06-task-conversation-summary-approaches.md) comparing transcript parsing vs prompt-based summarization. The recommendation is **server-side transcript parsing** (approach 1b): pass `transcript_path` from the hook stdin payload to the server, read the last assistant message from the JSONL, and store it on the session summary. This mirrors the existing `enrichCodexReviewMetadata` pattern and adds zero latency from model calls.

**Summary capture**:
- On `Stop` hook: read `transcript_path` from stdin payload, parse the JSONL server-side, extract the last meaningful assistant message (skip tool call acknowledgments)
- Store as a `summary` field on the session summary (separate from `finalMessage` to preserve both)
- Follow the existing `enrichCodexReviewMetadata` pattern — add an `enrichClaudeReviewMetadata` function in `hooks-api.ts`
- Consider unifying all agent enrichment into a single `enrichReviewMetadata` function
- Cap summary length (e.g. 500 chars) to prevent bloating session state

**Improved title generation**:
- Current auto-generated titles are low quality — they're derived from limited context at task creation time
- Once conversation summaries are available, re-derive the task title from the summary after the agent's first meaningful work session
- The summary has much richer context about what the agent actually did vs what the initial prompt said
- Only update the title if the user hasn't manually edited it

**Trash retention**: Summaries should persist on trashed cards so you can mouse over a trashed task and quickly see what it was about without restoring it. This is especially useful when the auto-generated title is vague — the summary gives the real context.

## 18. Investigate auto-trashing of tasks on restart

When Quarterdeck is closed and reopened, all open tasks (in_progress, review) get moved to trash. Investigate whether this is a technical requirement (e.g. agent sessions can't be resumed so the tasks are considered dead) or just a UX decision that was made early and never revisited.

If it's not technically required, reconsider whether this makes sense — losing your board state on every restart is disruptive, especially for tasks that were waiting for review or had meaningful progress. This is closely related to #1 (resume sessions after crash/closure) but is worth investigating independently since keeping cards in place may be possible even if session resumption isn't.

## 19. Unify task card behavior across views

The `BoardCard` component renders through two independent parent chains — the main board columns and the sidebar/context panel — and each threads props differently through intermediate components. Missing props silently disable features rather than erroring, which has already caused bugs (e.g. migrate button missing from sidebar cards). As more views are added (#8 project switcher, #9 sidebar decoupling), this divergence will get worse.

See [docs/research/2026-04-06-board-card-prop-threading-audit.md](research/2026-04-06-board-card-prop-threading-audit.md) for the full audit of current prop discrepancies between board and sidebar paths.

**Goals**:
- Audit and fix all current prop discrepancies between the board and sidebar rendering paths
- Future-proof so new views automatically get full card behavior without manual prop threading
- Consider a context-based approach (React context or a hook) so card callbacks don't need to be threaded through every intermediate component
- Ensure any new planned views (project switcher, decoupled sidebar) inherit full card interaction without per-view wiring
