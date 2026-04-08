# Completed

Features shipped since the initial planning doc. Listed in reverse chronological order.

## Decouple detail sidebar from task selection (2026-04-08, prev #13)

The detail sidebar (toolbar, panels, resize layout) no longer requires a task selection to render. Refactored into an always-visible 4-tab sidebar with Board, Terminal, Changes, and Files panels. The sidebar renders independently of card selection — when no task is selected, panels show workspace-level content or empty states. This is the enabling work for the git management view and project switcher.

## Session state reconciliation for stale UI badges (2026-04-08, prev #7)

Added periodic reconciliation that polls actual agent/session state and corrects stale UI badges (permission prompts, approval indicators). A 10-second interval job compares displayed status against live session data and auto-corrects mismatches. Also removed a flawed output-after-review reconciliation that was incorrectly bouncing tasks back to running state.

## Fix: branch display desync on task cards (2026-04-08)

Fixed branch name shown on task cards getting out of sync with the actual branch. Root cause was a different precedence for the branch field vs other live metadata — prioritized live metadata from the runtime over stale persisted state.

## Fix: chunky terminal rendering on low-DPR monitors (2026-04-08)

Switched to light font weight for terminal rendering to reduce overly bold/chunky text on low-DPI displays.

## Fix: LLM display summary lost across consecutive hook events (2026-04-08)

Fixed `displaySummary` being wiped when consecutive hook events (e.g. to_review followed by stop) overwrote the task card state. The summary is now preserved across hook event processing.

## Fix: output-after-review reconciliation bouncing tasks (2026-04-08)

Removed reconciliation logic that detected terminal output after a task entered review and incorrectly moved it back to running. Terminal output (spinners, ANSI redraws) doesn't indicate the agent resumed work — the hook system is the authoritative source for state transitions.

## Chore: dead code and unused dependency cleanup (2026-04-08)

Removed dead code, unused exports, and unused dependencies across the codebase.

## Fix: slight lag on audible notifications (2026-04-08)

Settle window reduced from 1500ms to 500ms for hook-based transitions, and non-hook transitions (exit, error, attention, failed) fire immediately at 0ms. Priority-based event upgrading ensures high-priority sounds aren't delayed by lower-priority pending events.

## Fix: branch name cleared on trashed task cards (2026-04-08)

Fixed `moveTaskToColumn` to only clear `workingDirectory` (not `branch`) when trashing. Branch field is preserved through the spread operator. Dedicated test coverage added.

## Cross-workspace audible notifications (2026-04-08)

Audible notifications now fire for tasks in all projects, not just the currently viewed one. Previously, switching projects silenced notifications from the previous project. Added a `task_notification` WebSocket message type that broadcasts session summaries to all connected clients (not workspace-scoped), with a separate `notificationSessions` map on the client that persists across project switches.

## Auto-restart shell terminals on unexpected exit (2026-04-08)

Non-agent shell terminals (home and detail) now automatically restart when they exit unexpectedly (non-zero or null exit code). Entirely frontend-driven with per-terminal crash-loop rate limiting (max 3 restarts per 30s window), a 1-second restart delay, and a `shellAutoRestartEnabled` settings toggle (default: true).

## Move prompt shortcut button from task cards to TopBar (2026-04-08, #27)

Prompt shortcut split button moved from per-card rendering in `BoardCard` to a single `TopBar` instance gated on task selection. Eliminated a 6-prop threading chain through CardDetailView -> ColumnContextPanel -> ColumnSection -> BoardCard.

## Unify LLM generation UI and disabled states (2026-04-08, #20)

Standardized all LLM-powered generation features (titles, branch names, summaries) with a unified Sparkles icon, proper disabled states when LLM is not configured, and a dedicated settings section explaining the env var requirements. Split summary character limits (LLM prompt budget vs display limit) to reduce mid-word truncation.

## Shared config test fixtures (2026-04-08, #28)

Consolidated ~10 duplicated config mock factories across test files into 2 shared factory files (`test/utilities/runtime-config-factory.ts` and `web-ui/src/test-utils/runtime-config-factory.ts`). Adding a config field now touches 1-2 files instead of 12, eliminating the #1 merge conflict source.

## Configurable prompt shortcuts for review cards (2026-04-07)

Replaced hardcoded commit/PR prompt injection buttons with a user-managed shortcuts system — dropdown selector, editor dialog, and localStorage persistence. Global config with task context interpolation.

## Fix: feature branch toggle default (2026-04-08, #29)

Reset the "Use feature branch" toggle to unchecked each time the create task dialog opens.

## Fix: trash worktree notice setting not respected (2026-04-08, #25)

Fixed stale project config causing the informational toast to always show. Refresh config after dismissing the toast.

## Fix: dragging tasks out of trash restores wrong task (2026-04-08, #21)

Fixed card ID mismatch in drag-and-drop handler when columns were sorted.

## Configurable audible notifications (#14)

Web Audio API with per-event toggles (permission, review, failure, completion), volume control, and "only when tab hidden" option in settings.

## Task conversation summaries and improved title generation (#17)

Transcript parsing on Stop hook, LLM-powered display summaries (<80 chars), hover tooltips on cards, staleness-checked regeneration.

## Create task dialog: shortcut remap (#7)

Shortcuts remapped: Cmd+Enter -> Start task, Cmd+Shift+Enter -> Start and open, Cmd+Alt+Enter -> Create only.

## Remove commit and PR prompt injection buttons (#5)

Buttons removed from all UI surfaces, prompt templates removed from config. `use-git-actions.ts` and `build-task-git-action-prompt.ts` retained for auto-review path only.

## Branch persistence on cards (#3)

Cards now persist their branch name through the task lifecycle.

## Trash confirmation and worktree notice (#2)

Confirmation dialog before trashing tasks with active worktrees, plus informational toast about worktree cleanup.

## Configurable prompt shortcuts (original #16 / Quick actions menu)

User-configurable prompt shortcuts dropdown replacing the hardcoded commit/PR buttons. Dropdown in review cards with editor dialog and localStorage persistence.
