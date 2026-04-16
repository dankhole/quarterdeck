# Dev Todo

Ordered hardest-first so easy items at the bottom are less likely to cause merge conflicts.

## Standalone desktop app (Electron/Tauri)

Move from a browser-based UI to a standalone desktop application, similar to how VS Code works. The current architecture — a Node.js server with a separate Vite dev server and the user opening a browser tab — has inherent limitations: no control over window management, tab lifecycle, or OS-level integration.

**Motivation**:
- Eliminate the browser-tab problem: multiple tabs hitting the same server cause duplicate WebSocket connections, state conflicts, and confusion about which tab is "the real one"
- Native window management — proper multi-window support (e.g. pop out a terminal into its own window), window restore on launch, system tray
- OS integration — file associations, deep links (`quarterdeck://open?project=...`), native notifications instead of browser permissions, global hotkeys
- Single launch experience — `quarterdeck` opens the app, not "start a server then open a URL"
- Offline-first without the "is my server running?" question

**Approach options**:
- **Electron** — proven path (VS Code, Cursor). The existing React frontend drops in as-is. The Node.js backend runs in the main process or a forked worker. Downside: bundle size, memory overhead.
- **Tauri** — Rust shell, smaller footprint, native webview. Frontend stays React. Backend would need to either stay as a sidecar Node process or be ported to Rust. Lighter than Electron but less mature ecosystem.

**Key decisions to make**:
- Electron vs Tauri (or something else)
- Whether the backend stays as a Node.js process (sidecar/fork) or gets embedded
- How to handle the transition period — support both standalone and browser mode, or cut over?
- Multi-project windowing model — one window per project, or tabbed projects within a single window?

## Fix session persistence across restart and un-trash

Three overlapping problems with session continuity:

- ~~**Sessions break after crash/closure**~~: **Fixed.** Running sessions are marked as interrupted during hydration. On first UI WebSocket connection, the server resumes them with `--continue` and `awaitReview=true` so they land in review (the agent is at its prompt, not actively working). Auto-restart on crash also uses `awaitReview=true`. Terminal scrollback from before the crash is still lost (in-memory only), but the agent picks up where it left off.
- ~~**Auto-trashing on graceful shutdown**~~: **Fixed.** Graceful shutdown preserves cards in their columns and marks sessions as "interrupted". The UI no longer auto-trashes interrupted sessions — the server owns the interrupted→review transition via `autorestart.denied`.
- **Un-trash doesn't reliably auto-resume**: After un-trashing a task, the terminal sometimes shows the original prompt but not the rest of the conversation context. Manually typing `/resume` works and brings back the full session. Investigate why auto-resume doesn't reliably trigger on un-trash.

## Branch management in git view

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
- **Rebase onto** — Rebase a task branch onto latest main before merging. Keeps history linear. (Note: conflict resolution and abort for in-progress rebases are already fully implemented — this is just the initiation action.)
- **Rename branch** — Minor convenience but nice for fixing typos.

**Tier 3 — Nice-to-have, power user:**
- **Interactive rebase** (reorder/squash commits) — Hard to do well in UI, questionable ROI.
- **Tag management** — Less relevant for the agent-worktree workflow.
- **Force push** — Dangerous, but sometimes needed after rebase. Requires confirmation dialog.
- **Revert commit** — Undo a specific commit without rewriting history.

**UI surface areas:**
- Branch context menu in `BranchSelectorPopover` — merge done; add delete, rename, create branch actions
- Branch context menu in `GitRefsPanel` (git history view) — extend with the same actions
- Git view tab bar or toolbar — stash controls, conflict state indicator, abort button

## Per-task session identity for non-isolated tasks

The client-side trash/untrash/start bugs for non-isolated tasks are fixed — `ensureTaskWorkspace` is no longer called (no orphan worktrees), dialog/toast messaging is correct, cleanup is skipped. However, the deeper session-scoping problem remains:

- **Session clobbering**: `--continue` picks the most recent conversation by CWD. Non-isolated tasks sharing the home repo all compete for the same "most recent" session. A warning toast now discloses this limitation on restore and restart, but there's no per-task session targeting.
- **Possible fix**: If Claude Code adds a `--session-id` or `--resume <id>` flag in the future, Quarterdeck could store the session ID per task and resume the correct conversation. Until then, this is a known limitation for non-isolated tasks.

## Fix agent state tracking bugs

Multiple related bugs where the UI shows the wrong task state. A comprehensive analysis and refactor plan exists at [docs/archived/refactor-session-lifecycle.md](archived/refactor-session-lifecycle.md) — it covers root causes, targeted patches, and a structural decomposition of `session-manager.ts`.

**Fixed:**
- ~~**Permission race condition** (high)~~: Stale `PostToolUse` after `PermissionRequest` no longer bounces state back to running. Permission-aware transition guard in `hooks-api.ts` blocks `to_in_progress` during permission state (exempts `UserPromptSubmit`).
- ~~**Hook delivery timeouts** (low)~~: Checkpoint capture is now fire-and-forget — tRPC response returns immediately after state transition, preventing CLI timeouts.
- ~~**API errors leave session stuck in "running"** (medium)~~: Reconciliation sweep now detects running sessions that haven't received a hook in over 60 seconds and marks them as stalled. UI shows an orange "Stalled" badge with explanatory tooltip. Auto-clears when hooks resume.

**Remaining issues:**
- **Non-hook operations stick in wrong state** (medium): Auto-compact, plugin reload, and `/resume` produce no hook events. Compact and plugin reload get stuck in "running"; `/resume` after review doesn't transition back to running.
- **Notification beep count wrong for rapid transitions** (low): When a task goes to review then quickly to needs-input, wrong beep count plays. Debounce/settle window issues cause double-beeps for single events or single beeps for multiple events.

## Client-side project switch optimizations

Server-side latency for project switching has been addressed (metadata decoupled from snapshot, file reads parallelized, inactive project task counts cached). Preload-on-hover is done. Remaining client-side strategy to make switching feel instant:

- **Stale-while-revalidate**: Cache board state per project in memory. On switch, show the cached version immediately while fresh data loads. Requires careful gating of `canPersistWorkspaceState` and `workspaceRevision` to prevent stale data from being persisted back to disk.
- **Keep multiple project boards in memory**: Investigate whether it's feasible to keep task boards for inactive projects hydrated in memory so switching doesn't require a full reload. Even if full state isn't kept, the board layout and task list should be cheap to retain.

## Upstream sync: periodic review of cline/kanban (recurring)

Periodically review the upstream [cline/kanban](https://github.com/cline/kanban) project for recent bug fixes and improvements worth reimplementing. The codebase has diverged significantly (200+ commits, `cline-sdk/` removed entirely) so most changes need reimplementation rather than direct cherry-picks. Roughly half of upstream output is Cline SDK/account work that will never apply; the other half is shared UI/UX where ideas are portable even if code isn't.

**Cadence:** Check weekly-ish. Run `git fetch upstream && git log upstream/main --oneline --since="<last check date>"` and evaluate new commits.
**Tracker:** [docs/upstream-sync.md](upstream-sync.md) — living doc with Adopted / Backlog / Decided against sections. Update it after each review.

## Audit CI/CD and deployment infrastructure

Review the existing GitHub Actions workflows (`ci.yml`, `test.yml`, `publish.yml`), issue templates, CODEOWNERS, and the changelog extraction script. Decide what's still relevant from the upstream fork, what needs updating (e.g. Slack webhook, CODEOWNERS), and whether anything is missing (e.g. automated changelog generation, release notes workflow).

## Publish to npm

Register the `quarterdeck` package on npm, configure OIDC trusted publishing for the GitHub repo, and do the first publish via the existing `publish.yml` workflow. Once published, update the README install instructions to use `npx quarterdeck` / `npm i -g quarterdeck` instead of the current clone-and-build steps.

## Archive stale docs (recurring)

Periodically read through docs in `docs/` (research, plans, specs, top-level) and archive anything that's for completed work. Clean up stale or outdated documents. Docs accumulate as features ship — this isn't a one-time task.

## UI branch/status indicators desync when agent leaves worktree

When `worktreeAddQuarterdeckDir` is enabled, agents can `cd` out of their assigned worktree into other directories. The status bar branch pill, task card branch label, and branch selector dropdown all derive their values from the agent's current working directory (via the metadata monitor's git probe), so they start showing the wrong branch state instead of the worktree's. Fix the metadata monitor and/or display logic so that task-scoped UI elements always reflect the assigned worktree path, not wherever the agent's shell happens to be. The statusline (`buildStatuslineCommand`) may also need the same fix.

**Related symptom:** The status bar sometimes shows the wrong project folder — may be the same metadata monitor root cause or a separate project-level resolution bug.

## "Shared" indicator on task cards should update when agent moves to shared directory

Task cards show a "shared" badge when a task is operating in the shared home workspace instead of an isolated worktree. When `worktreeAddQuarterdeckDir` is enabled, an agent that was started in an isolated worktree can `cd` into shared directories — at that point the task is effectively operating in shared space, but the card still shows as isolated. The "shared" indicator should react to the agent's actual working directory, not just the initial launch config.

## Add clarification when multiple worktrees share the same detached HEAD hash

When tasks are created without a feature branch, their worktrees are all detached at the same base commit. The status bar, card branch pill, and branch dropdown all show the same short commit hash, which looks like a bug. Add a tooltip or subtle label at these display points explaining that the worktrees are independent copies detached from the same base ref — changes in one won't affect others. Consider showing "detached from {baseRef}" instead of just the raw hash.

## Revisit HTML chat view concept

The experimental HTML chat view (`terminalChatViewEnabled`) was removed because the implementation was incomplete and noisy — it stripped ANSI formatting and read from xterm's buffer, but output was unreliable for full-screen TUIs like Claude Code. Revisit the concept at some point: rendering agent output as styled HTML instead of a terminal canvas could enable better text selection, search, copy/paste, and accessibility. Would need a fundamentally different approach — likely parsing the agent's structured output (if available) rather than scraping the terminal buffer.

## Commit sidebar: Auto-fill commit message on open

Auto-fill a default commit message when the commit sidebar opens (not just via the generate button, which is already implemented). Pre-fill from the task title, diff summary, and optionally agent session context. The message should be fully editable. Consider using the agent's conversation context (why it made changes, not just what changed) to produce better messages than a blind diff summary — this is a differentiator over standard IDE commit message generation.

## Full Codex support

Codex has basic launch, event parsing, and workspace trust working, but it's far from feature parity with Claude. The infrastructure is "make it run" — this is about "make it first-class."

**What works today:**
- Agent registration, selection, and onboarding UI
- CLI launch via `codexAdapter` (autonomous mode, resume, plan mode)
- Hook wrapper (`codex-wrapper`) with session log and rollout log event parsing
- Workspace trust auto-confirmation
- Prompt readiness detection

**Missing — core gaps:**
- **Conversation history in UI**: Claude exposes chat messages via API; Codex has no equivalent. The sidebar chat view is blank for Codex tasks. Need to either parse Codex session logs into a chat-like format or build a Codex-specific history endpoint.
- **Per-task session resume**: Resume uses `codex resume --last` which picks the most recent session globally, not per-task. Same session-clobbering problem as Claude non-isolated tasks (see "Per-task session identity" above). If Codex adds session ID targeting, wire it up.
- **Hook configuration**: Claude gets a full `settings.json` with hook matchers (`PreToolUse`, `PostToolUse`, etc.). Codex gets nothing — the wrapper is a thin pass-through. Need to define what Codex-side hook configuration looks like and whether it can support the same granularity.
- **Error diagnostics**: If session logs aren't written or rollout file discovery fails, failures are silent. Add explicit error reporting when both log sources fail, and surface it in the UI.

**Missing — polish:**
- No Codex-specific documentation or setup guide
- No version detection or capability checking beyond `isBinaryAvailableOnPath()`
- Rollout file discovery scans up to 250 files by CWD match — may need optimization for heavy usage
- Non-hook operations (auto-compact, plugin reload, `/resume`) likely have the same stuck-state issues as Claude (see "Fix agent state tracking bugs" above)

## File browser and diff viewer performance

The file browser and diff viewer are laggy, especially for tasks with many changed files or large diffs. Investigate and address:

- **First-open latency**: Opening the compare view or uncommitted-changes view for the first time is noticeably slow. Add debug logging to identify where time is spent (git commands, data serialization, WebSocket transfer, React rendering) before optimizing.
- **File browser**: Slow to load and navigate. Profile whether the bottleneck is git command execution (status, ls-files), data transfer over WebSocket, or React rendering. Tree expansion and file selection should feel instant.
- **Diff viewer**: Large diffs cause noticeable UI lag. Full file text (old + new) is sent inline and diff computation happens client-side. Consider server-side diff computation, virtualized rendering for large files, or lazy-loading diffs per file instead of all at once.
- **Interaction between the two**: Selecting a file in the browser triggers a diff load — if this round-trips to the server each time, latency compounds. Consider pre-fetching diffs for visible files or caching previously viewed diffs.
- **Commit from sidebar is slow**: The commit action triggered from the sidebar loads for a while before completing. Profile whether the bottleneck is the git commit itself, pre-commit hooks, diff recomputation after commit, or UI update.

## Readability refactoring roadmap (C#-style navigability)

Full plan at [docs/archived/refactor-csharp-readability.md](archived/refactor-csharp-readability.md). Eight concrete tasks to make the codebase navigable like a well-structured C# solution — ctrl+click through interfaces, see contracts at a glance, trace data flow without grep.

**Backend (sections 1-7):** All done.
- ~~Adopt `neverthrow` and `mitt`~~ — installed, ready for incremental adoption
- ~~Named types~~ — replaced `ReturnType<typeof>` gymnastics across 11 sites with navigable named types
- ~~IDisposable + DisposableStore~~ — created `src/core/disposable.ts` (~70 lines), adopted by RuntimeStateHub
- ~~Convert `RuntimeStateHub` to class~~ — 550-line factory → `RuntimeStateHubImpl` extending `Disposable`
- ~~Convert `RuntimeApi` to class~~ — 615-line factory → `RuntimeApiImpl` class
- ~~Split `RuntimeApi` handlers into individual files under `src/trpc/handlers/`~~ — 11 handler files, `RuntimeApiImpl` is a thin dispatcher
- ~~Shared service interfaces~~ — `IRuntimeBroadcaster`, `ITerminalManagerProvider`, `IWorkspaceResolver`, `IRuntimeConfigProvider`, `IWorkspaceDataProvider` replace 4 bespoke dependency bags
- ~~Message factory functions + typed WebSocket dispatch map~~ — 11 factory functions replace inline construction, compiler-enforced handler map replaces 110-line if/else chain

**Frontend (section 8): Provider migration — done.**

All hooks migrated out of the monolithic App component into 6 focused providers (ProjectProvider, BoardProvider, TerminalProvider, GitProvider, InteractionsProvider, DialogProvider). AppCore eliminated. App is now a ~50-line composition root rendering the provider tree. AppContent (~1150 lines) remains as the leaf component with side-effect hooks and JSX.

**After the provider migration**, two follow-up refactors build on it (do in order):

1. ~~**Organize hooks into domain subdirectories**~~ — done. 78 flat files reorganized into 5 domain subdirectories (`board/`, `git/`, `terminal/`, `project/`, `notifications/`), 5 non-hook files relocated to proper directories (`utils/`, `terminal/`, `components/`), ~123 import sites updated.
2. **Extract business logic from hooks into plain TS modules** — see "Organize web-ui hooks directory" todo below

## Remove non-WebGL terminal renderer option

The `terminalWebGLRenderer` config toggle and canvas 2D fallback path exist as an escape hatch, but WebGL is the default and the better experience. Remove the toggle from settings, the `setWebGLRenderer` method, the `updateGlobalTerminalWebGLRenderer` plumbing, and always load the WebGL addon. Keep the `onContextLoss` handler so a lost WebGL context doesn't crash the terminal.

## Revisit periodic orphaned entity cleanup

Review and improve the periodic cleanup of orphaned entities — stale worktrees, abandoned sessions, dangling state references — that accumulate over time. Session reconciliation (`session-reconciliation.ts`) runs every 10 seconds for process/session state, but broader orphan cleanup (worktrees without tasks, tasks referencing deleted worktrees, leftover `.quarterdeck/` artifacts) may need a separate sweep.

## Organize web-ui hooks directory and extract domain logic

**Prereq:** Finish the provider migration (see "Readability refactoring roadmap" above) before starting this. The provider migration establishes the context interfaces that this work builds on.

Three phases, done in order:

1. ~~**Subdirectory reorg**~~ — Done. Moved 78 files into 5 domain subdirectories plus relocated 5 misplaced non-hook files. Pure file moves + import path updates.
2. **Domain logic extraction** — For hooks with >50 lines of business logic, split into a pure TS domain module (`foo-bar.ts`) and a thin React hook (`use-foo-bar.ts`). The domain module has zero React imports and is testable without `renderHook`. Do incrementally, hook-by-hook. Methodology: [docs/patterns-frontend-service-extraction.md](patterns-frontend-service-extraction.md) Pattern 1. Specifics (candidates, naming, examples): [docs/refactor-hooks-directory.md](refactor-hooks-directory.md) Phase 2.
3. **Conventions update** — Add "Hooks architecture" section to `web-ui-conventions.md` to codify the domain-module pattern and directory structure. Plan: [docs/refactor-hooks-directory.md](refactor-hooks-directory.md) Phase 3.

## Keep task base ref in sync with branch changes

When a task's branch changes (e.g. user checks out a different branch in the worktree), the base ref should auto-update to match the new branch's parent (e.g. if the new branch was forked from `develop`, base switches from `main` to `develop`). Currently the base ref is set at task creation and never updates. This affects "from main" labels and behind-base notifications showing stale info. Add a manual override option for when auto-detection gets it wrong.

## Investigate and fix statusline ↓↑ counters vs task card stats

The agent statusline shows `374↓ 207↑` (total input/output tokens from Claude's cost data) and `+0 -0` (total lines added/removed). These don't obviously correspond to what's shown on the task card, and they don't appear to update after a commit. Investigate: what exactly do these counters track, why don't they match the task card's stats, and why don't they refresh on commit? Fix the desync.

## Fix "needs input" yellow dot incorrectly persisting across project switches

The yellow "needs input" indicator on the board icon sometimes shows for projects that don't actually need input. The erroneous state follows the project — switching projects brings the wrong NI status along. Investigate whether this is a stale hook state issue, a project-scoping bug in the notification system, or a UI render bug.

## Investigate inline comments in diff viewer

The diff viewer has some inline comment infrastructure. Investigate how it currently works (or doesn't), what state it's in, and whether it's usable or needs work. Document findings.

## Assess and adjust live terminal WebGL context limit

Browsers support ~8–16 WebGL contexts (varies by browser/GPU). The current limit is 4 live terminals. At least 1 context must be reserved for the shell terminal. Investigate the actual browser limits, measure what happens at the boundary, and adjust the limit if the research supports a higher number.

## "Reset to here" in branch context menu

Add a "Reset to here" action in the top-bar branch context menu that performs `git reset --hard <selected-ref>` on the task's worktree branch. Must include a confirmation dialog ("Are you sure? This will discard all commits after X and any uncommitted changes."). This is per-worktree only — never touches the main repo.

## Don't defocus agent terminal after submitting input

After pressing enter to submit input in the agent chat, keyboard focus should stay on the agent terminal. Currently focus leaves and requires a click to re-engage. When both agent terminal and shell terminal are visible, focus should go to whichever was last clicked — but the default (agent terminal only) should never lose focus on submit.

## Restore sidebar panel state when returning to agent chat

If a sidebar panel (e.g. task column) was open before switching to a full-screen main view (e.g. file browser), it should automatically reopen when navigating back to agent chat. Currently the sidebar state is lost on view switch.

## Remember last viewed file when switching tasks

When switching away from a task and back, the diff viewer / compare view should remember which file was last selected. Currently switching tasks resets the file selection.

## File browser: preserve scroll position

The file browser should save and restore its scroll position when navigating away and back (e.g. switching tabs or tasks). Currently it resets to the top each time.

## Skip trash confirmation when task has no uncommitted or unmerged changes

The trash confirmation dialog should only appear when the task has uncommitted changes or an unmerged branch. If there's nothing to lose, trash immediately without prompting.

## Task card hover buttons should have a short delay

Add a brief delay (~200ms) before task card hover action buttons appear. Prevents accidental triggers when the mouse passes over cards while navigating the board.

## Audit default branch resolution for bugs

The recent `resolveDefaultBaseRef` unification should be functionally tested. Also verify the three-dot compare behavior is correct with various branch configurations. This is a targeted bug audit, not new feature work.

## Add timestamps to all runtime logging

Ensure all runtime log output includes timestamps. Audit existing logging paths (console logger, JSONL event log, debug ring buffer) and add timestamps where missing.

## ~~Archive current changelog and implementation log~~

**Done** — 0.9.0 release. Archived to `docs/changelog-through-0.8.0.md` and `docs/implementation-log-through-2026-04-15.md`.
