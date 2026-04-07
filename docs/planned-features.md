# Planned Features

## 1. Resume card sessions after crash/closure

When Kanban crashes or is closed and reopened, clicking on existing cards no longer works — the Claude Code chat is unresponsive/broken. Need to:
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

## 4. Detail toolbar and diff viewer improvements

Continuing work on the left toolbar and diff viewer UX:

- **Diff viewer resize past midway**: The file tree panel clamp is currently max 0.6 in `use-card-detail-layout.ts`, so the diff viewer floors at 40% width. Increase the max to allow the diff viewer to take most or all of the horizontal space.
- **Git history resize handle is inverted**: In `git-commit-diff-panel.tsx`, the resize handler uses `startRatio - deltaRatio` (minus) instead of `startRatio + deltaRatio` (plus), inverting the drag direction. The main `card-detail-view.tsx` handle is correct.
- **Interactive base ref switcher**: The diff toolbar now shows the branch comparison (e.g. `feat/my-feature → main`). Make this interactive — clicking the base ref should open a dropdown/popover to select a different branch to diff against, so users can compare their work against any branch, not just the original base ref.

## 5. Direct git commit from review (server-side)

The commit button currently works by injecting a prompt into the agent's terminal, relying on the agent to execute the git commands. Replace the default behavior with a direct server-side git commit:

- **Server-side commit (new default)**: Add a tRPC mutation (e.g. `runtime.commitTaskChanges`) that stages all changes in the task worktree and commits directly using `runGit()`. No active agent session required — faster and more reliable.
- **Commit message generation**: Auto-generate a commit message from the task title/description and diff summary (changed file names, additions/deletions). Optionally support calling an LLM endpoint for smarter messages.
- **Agent prompt injection (alternate)**: Keep the current prompt-injection approach as a secondary option (e.g. "Ask agent to commit") for cases where the user wants the agent to craft the message with full task context.
- **UI**: The card and agent terminal panel commit buttons should default to the direct commit. Add a dropdown or secondary action for the agent-assisted variant.

## 6. Performance audit for concurrent agents

Audit and address performance bottlenecks that emerge when running many agents simultaneously. An earlier analysis exists at [docs/performance-bottleneck-analysis.md](performance-bottleneck-analysis.md) but is likely out of date — use it as a starting point, not a source of truth. Key areas to re-evaluate:

- State persistence lock contention under concurrent checkpoint writes
- WebSocket broadcast fan-out scaling with multiple agents and browser tabs
- Frontend memory growth (chat messages, terminal cache) over long sessions
- PTY output fanout and shared backpressure across viewers
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

Integrate [Pulse](https://github.com/anthropics/pulse) — a Rust CLI tool that enhances the Claude Code status bar with rich glyphs — into Kanban's terminal/status display when Nerd Fonts are detected.

**Investigation needed**:
- How Pulse works: is it a binary Kanban shells out to, a library, or something that wraps the agent process?
- Where it would integrate: per-agent terminal status lines, a global Kanban status bar, board card indicators, or some combination
- How to detect Nerd Fonts availability at runtime

**Requirements**:
- Auto-detect Nerd Fonts — if present, use Pulse-enhanced status display; if not, fall back to the current plain text display
- Should be seamless — no user configuration required beyond having Nerd Fonts installed
- Pulse is a tool made by a coworker, so coordinate with them on the integration surface

## 12. Rename and rebrand as a fork

This project is a fork of [kanban-org/kanban](https://github.com/kanban-org/kanban) that has been progressively diverging with significant new features and architectural changes. It currently still carries the original name, repo references, and npm package identity. Need to:

- **Rename the project** — pick a new name that reflects the new direction (light AI IDE, multi-agent orchestration, terminal-centric — kanban is just one view). Available on npm:
  - **Braid** — braiding parallel agent threads into a cohesive result. Short, memorable, `npx braid` reads well. **Frontrunner.**
  - **Quarterdeck** — the command deck of a ship. Strong metaphor for orchestration. Longer, but distinctive and `npx quarterdeck` has presence.
  - **Cupola** — an observation dome. Distinctive, evokes overseeing agents from above.
  - **Tackboard** — compound, available but sounds like a physical object.
  - **Loomboard** — compound, available but less punchy.
- **Update package.json** — new name, author/contact info, repository URL pointing to the fork
- **Update CLAUDE.md** — currently says "Published to npm as `npx kanban`. Repository: https://github.com/kanban-org/kanban" which is the upstream, not this fork
- **Add attribution** — clearly state in README and package metadata that this was forked from kanban-org/kanban and that much of the foundational work is theirs
- **Update CI/CD** — publish.yml references the upstream npm package and Slack webhook; update for the new identity
- **Consider npm scope** — publish under a scoped package name (e.g. `@dcole/kanban` or the new project name) to avoid conflicts with the upstream package

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
