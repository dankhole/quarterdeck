# Dev Todo

Ordered hardest-first so easy items at the bottom are less likely to cause merge conflicts.

## Optimization-shaped architecture follow-ups

Use this section together with:

- [docs/design-guardrails.md](./design-guardrails.md)
- [docs/optimization-shaped-architecture-followups.md](./optimization-shaped-architecture-followups.md)
- [docs/terminal-architecture-refactor-brief.md](./terminal-architecture-refactor-brief.md)
- [docs/terminal-ws-server-refactor-brief.md](./terminal-ws-server-refactor-brief.md)

These items all share the same architectural smell: a subsystem started with a simple core job, then accumulated enough clever optimization/recovery behavior that the optimization began to shape the design.

## Architecture follow-ups from the design roadmap

Use this section together with:

- [docs/design-weaknesses-roadmap.md](./design-weaknesses-roadmap.md)
- [docs/refactor-roadmap-context.md](./refactor-roadmap-context.md)
- [docs/task-state-system.md](./task-state-system.md)

These items are broader ownership-boundary refactors that do not yet need full implementation briefs, but they need enough written context that a fresh agent can pick them up without rediscovering the problem from scratch.

- Investigate split-brain task state across persistence, in-memory runtime state, websocket deltas, browser board state, and client-side cache/restore behavior. Roadmap context: [docs/refactor-roadmap-context.md#4-split-brain-task-state](./refactor-roadmap-context.md#4-split-brain-task-state)
- Reduce manual broadcast choreography by making post-mutation effects easier to express through stronger domain-event or post-mutation boundaries. Roadmap context: [docs/refactor-roadmap-context.md#5-manual-broadcast-choreography--domain-event-boundaries](./refactor-roadmap-context.md#5-manual-broadcast-choreography--domain-event-boundaries)
- Narrow broad provider/context surfaces, especially where project-, git-, or interaction-related providers currently expose mixed-domain ownership. Roadmap context: [docs/refactor-roadmap-context.md#7-broad-provider--context-surfaces](./refactor-roadmap-context.md#7-broad-provider--context-surfaces)

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
- Rebase onto — context menu action on any non-current branch, rebases current branch onto selected ref, integrates with existing conflict resolver for multi-round rebase conflicts, confirmation dialog warns about history rewriting
- Rename branch — context menu action on local branches, dialog with pre-filled editable input, disabled on worktree-locked branches
- Reset to here — context menu action on any branch/ref, performs `git reset --hard` to selected ref, danger-styled confirmation dialog, works in both home repo and task worktrees

**Tier 3 — Nice-to-have, power user:**
- **Interactive rebase** (reorder/squash commits) — Hard to do well in UI, questionable ROI.
- **Tag management** — Less relevant for the agent-worktree workflow.
- **Force push** — Dangerous, but sometimes needed after rebase. Requires confirmation dialog.
- **Revert commit** — Undo a specific commit without rewriting history.

**UI surface areas:**
- Branch context menu in `BranchSelectorPopover` — checkout, compare, merge, create, delete, rename, rebase, reset, pull, push, pin
- Branch context menu in `GitRefsPanel` (git history view) — checkout, create, pull, rebase, rename, reset
- Git view tab bar or toolbar — stash controls, conflict state indicator, abort button

## Per-task session identity for non-isolated tasks

The client-side trash/untrash/start bugs for non-isolated tasks are fixed — `ensureTaskWorktree` is no longer called (no orphan worktrees), dialog/toast messaging is correct, cleanup is skipped. However, the deeper session-scoping problem remains:

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

- ~~**Stale-while-revalidate**: Cache board state per project in memory. On switch, show the cached version immediately while fresh data loads. Requires careful gating of `canPersistProjectState` and `projectRevision` to prevent stale data from being persisted back to disk.~~ **Done.** Module-scoped `project-board-cache.ts` stashes board/sessions/revision/project metadata per project (5-minute TTL, max 10 entries). On project switch, the previous board is stashed and the target board is restored from cache immediately — the loading spinner is suppressed and the cached board is displayed while fresh data loads in the background. `canPersistProjectState` stays `false` until authoritative data arrives, preventing stale writes. Complements the existing preload-on-hover cache (first visits) with long-lived caching (revisits).
- ~~**Keep multiple project boards in memory**: Investigate whether it's feasible to keep task boards for inactive projects hydrated in memory so switching doesn't require a full reload. Even if full state isn't kept, the board layout and task list should be cheap to retain.~~ **Done.** The board cache retains up to 10 project boards in memory simultaneously. Boards are cheap to retain (task cards, columns, dependencies, sessions). Terminal connections and WebSocket subscriptions are still cleaned up on switch — only the serializable board state is cached.

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

## Refactor Codex support to use native hooks

Codex now has first-party hooks (`hooks.json`, native hook events, and session-targeted resume) in the official OpenAI docs, but Quarterdeck still routes Codex through the legacy `codex-wrapper` watcher path. Replace the wrapper-first integration with native Codex hook configuration where possible: generate Codex hook files alongside launch config, map native `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` events into Quarterdeck transitions, and use native session IDs for resume instead of `codex resume --last`. Keep any log-watcher fallback only for gaps the native hook surface still cannot cover.

## Make supporting LLM features provider-neutral

Supporting LLM UX (titles, summaries, helper generations) is still Anthropic-only: `src/title/llm-client.ts` assumes Anthropic Bedrock-compatible env vars and a Claude default model, so Codex/OpenAI-only setups leave these features effectively disabled. Refactor the shared LLM client to support provider-neutral configuration, including direct OpenAI-compatible endpoints and config-driven model/provider selection, so auxiliary UX works regardless of whether the task agent is Claude or Codex.

## Harden Codex install and capability detection

Codex detection currently stops at “binary exists on PATH,” and the install link still points to the GitHub repo instead of the current OpenAI docs surface. Add real Codex capability detection: verify CLI version and/or feature support for hooks, session-targeted resume, config/rules/AGENTS support, approvals/security modes, and app-server/remote features before enabling related UX. Update install/help links to the official OpenAI Codex docs.

## Make the worktree system prompt apply to Codex too

The settings UI advertises the worktree system prompt as an agent-wide feature, but only the Claude launch path currently injects it. Extend the Codex adapter so `worktreeSystemPromptTemplate` is applied for Codex sessions too, or scope the UI copy if Codex cannot support the same mechanism. Avoid the current silent mismatch where users customize the prompt and Codex ignores it.

## File browser and diff viewer performance

The file browser and diff viewer are laggy, especially for tasks with many changed files or large diffs. Investigate and address:

- **First-open latency**: Opening the compare view or uncommitted-changes view for the first time is noticeably slow. Add debug logging to identify where time is spent (git commands, data serialization, WebSocket transfer, React rendering) before optimizing.
- **File browser**: Slow to load and navigate. Profile whether the bottleneck is git command execution (status, ls-files), data transfer over WebSocket, or React rendering. Tree expansion and file selection should feel instant.
- **Diff viewer**: Large diffs cause noticeable UI lag. Full file text (old + new) is sent inline and diff computation happens client-side. Consider server-side diff computation, virtualized rendering for large files, or lazy-loading diffs per file instead of all at once.
- **Interaction between the two**: Selecting a file in the browser triggers a diff load — if this round-trips to the server each time, latency compounds. Consider pre-fetching diffs for visible files or caching previously viewed diffs.
- **Commit from sidebar is slow**: The commit action triggered from the sidebar loads for a while before completing. Profile whether the bottleneck is the git commit itself, pre-commit hooks, diff recomputation after commit, or UI update.

## Design investigation follow-ups

Full plan at [docs/plan-design-investigation.md](plan-design-investigation.md). These are architectural follow-ups for places where the concern may be incorrect responsibility boundaries or overlapping ownership, not just readability.

- ~~**Reassess board-state ownership between browser and runtime**~~ — Done (cbf81f71). Board rule consolidation confirmed `task-board-mutations.ts` as the canonical owner; browser layer is a thin adapter.
- ~~**Reassess terminal architecture across `terminal-slot.ts` and `terminal-pool.ts`**~~ — Done (c9abe225). Slot decomposed into `slot-dom-host.ts` + `slot-visibility-lifecycle.ts`; pool split into shared-pool policy + `terminal-dedicated-registry.ts`.
- ~~**Reassess runtime coordination boundaries between `runtime-state-hub.ts` and `workspace-registry.ts`**~~ — Done (c9abe225). Hub split into coordinator + `runtime-state-client-registry.ts` + `runtime-state-message-batcher.ts`.
- ~~**Reassess large UI components that still own workflow state**~~ — Done. The app-shell audit is wrapped up: `project-navigation-panel.tsx` and `top-bar.tsx` are decomposed, and the remaining component line-count cleanup is tracked below in Phase 3 so the work only has one active home.

## Frontend feature folders, component decomposition, and barrel exports

Four phases to make the frontend navigable like a C#/Angular solution — feature-grouped directories, no 700-line components, clean barrel imports.

- ~~**Phase 1**~~ — Sort 15 orphan hooks into domain subdirectories (`hooks/app/`, `hooks/debug/`, `hooks/settings/`, and existing dirs). Pure file moves. Done.
- ~~**Phase 2**~~ — Group 48 root-level components into feature directories (`components/board/`, `components/task/`, `components/git/`, `components/app/`, `components/terminal/`, `components/debug/`). Pure file moves. Done.
- **Phase 3** — Finish the remaining oversized component decompositions, targeting ~400 lines max where the structure still supports it. Done on this branch: `project-navigation-panel.tsx` (679L → 74L), `top-bar.tsx` (624L → 176L), and `git-view` (757L → 255L view + 343L hook + 88L domain module + 132L CompareBar + 36L empty panels). Remaining planned work: `board-card.tsx` (521L), `task-create-dialog.tsx` (544L), `branch-selector-popover.tsx` (698L), and `card-detail-view.tsx` (585L). Roadmap context: [docs/refactor-roadmap-context.md#8-remaining-workflow-heavy-ui-surfaces](./refactor-roadmap-context.md#8-remaining-workflow-heavy-ui-surfaces)
- ~~**Phase 4**~~ — Add `index.ts` barrel exports to all feature directories in both `components/` and `hooks/`. Done.

## Readability refactoring roadmap (C#-style navigability) — completed

Full plan at [docs/archived/refactor-csharp-readability.md](archived/refactor-csharp-readability.md). Eight concrete tasks to make the codebase navigable like a well-structured C# solution — ctrl+click through interfaces, see contracts at a glance, trace data flow without grep.

**Backend (sections 1-7):** All done.
- ~~Adopt `neverthrow` and `mitt`~~ — installed, ready for incremental adoption
- ~~Named types~~ — replaced `ReturnType<typeof>` gymnastics across 11 sites with navigable named types
- ~~IDisposable + DisposableStore~~ — created `src/core/disposable.ts` (~70 lines), adopted by RuntimeStateHub
- ~~Convert `RuntimeStateHub` to class~~ — 550-line factory → `RuntimeStateHubImpl` extending `Disposable`
- ~~Convert `RuntimeApi` to class~~ — 615-line factory → `RuntimeApiImpl` class
- ~~Split `RuntimeApi` handlers into individual files under `src/trpc/handlers/`~~ — 11 handler files, `RuntimeApiImpl` is a thin dispatcher
- ~~Shared service interfaces~~ — `IRuntimeBroadcaster`, `ITerminalManagerProvider`, `IProjectResolver`, `IRuntimeConfigProvider`, `IProjectDataProvider` replace 4 bespoke dependency bags
- ~~Message factory functions + typed WebSocket dispatch map~~ — 11 factory functions replace inline construction, compiler-enforced handler map replaces 110-line if/else chain

**Frontend (section 8): Provider migration — done.**

All hooks migrated out of the monolithic App component into 6 focused providers (ProjectProvider, BoardProvider, TerminalProvider, GitProvider, InteractionsProvider, DialogProvider). AppCore eliminated. App is now a ~50-line composition root rendering the provider tree. AppContent reduced from ~1150 to ~820 lines by extracting three JSX-heavy sections into ConnectedTopBar, HomeView, and AppDialogs components.

**After the provider migration**, two follow-up refactors build on it (do in order):

1. ~~**Organize hooks into domain subdirectories**~~ — done. 78 flat files reorganized into 5 domain subdirectories (`board/`, `git/`, `terminal/`, `project/`, `notifications/`), 5 non-hook files relocated to proper directories (`utils/`, `terminal/`, `components/`), ~123 import sites updated.
2. ~~**Extract business logic from hooks into plain TS modules**~~ — done. See "Organize web-ui hooks directory" todo below.

## Revisit periodic orphaned entity cleanup

Review and improve the periodic cleanup of orphaned entities — stale worktrees, abandoned sessions, dangling state references — that accumulate over time. Session reconciliation (`session-reconciliation.ts`) runs every 10 seconds for process/session state, but broader orphan cleanup (worktrees without tasks, tasks referencing deleted worktrees, leftover `.quarterdeck/` artifacts) may need a separate sweep.

## Organize web-ui hooks directory and extract domain logic

**Prereq:** Finish the provider migration (see "Readability refactoring roadmap" above) before starting this. The provider migration establishes the context interfaces that this work builds on.

Three phases, done in order:

1. ~~**Subdirectory reorg**~~ — Done. Moved 78 files into 5 domain subdirectories plus relocated 5 misplaced non-hook files. Pure file moves + import path updates.
2. ~~**Domain logic extraction**~~ — Done (16 domain modules, 211 domain-level unit tests). Split hooks into domain module + thin React wrapper pairs. Named candidates `use-board-interactions` and `use-task-start` confirmed as pure orchestration hooks with no extractable domain logic. Methodology: [docs/patterns-frontend-service-extraction.md](patterns-frontend-service-extraction.md) Pattern 1.
3. ~~**Conventions update**~~ — Done. Added "Hooks architecture" section to `docs/web-ui-conventions.md` covering directory structure, domain module pattern, naming, re-exports, and reference table. Updated `AGENTS.md` with extraction rule.

## Fix "needs input" yellow dot incorrectly persisting across project switches

The yellow "needs input" indicator on the board icon sometimes shows for projects that don't actually need input. The erroneous state follows the project — switching projects brings the wrong NI status along. Investigate whether this is a stale hook state issue, a project-scoping bug in the notification system, or a UI render bug.

## Skip trash confirmation when task has no uncommitted or unmerged changes

The trash confirmation dialog should only appear when the task has uncommitted changes or an unmerged branch. If there's nothing to lose, trash immediately without prompting.

## Auto-update base ref when branch changes to an integration branch

When an agent switches branches inside a task worktree, the metadata monitor calls `resolveBaseRefForBranch` to auto-update the card's base ref. If the new branch is an integration branch like `main`, `resolveBaseRefForBranch` returns `null` (it can't find a parent for `main`) and the update is silently skipped — leaving the card with a stale base ref that no longer makes sense.

**Fix:** When `resolveBaseRefForBranch` returns `null`, clear the card's base ref instead of silently keeping the old value. This requires:

- Allow empty-string `baseRef` to mean "unresolved — user needs to pick" (currently `baseRef` is validated as non-empty everywhere: board mutations, worktree creation, API schema).
- Update the monitor's `checkForBranchChanges` to broadcast `""` when resolved is `null`, instead of skipping.
- Update `useTaskBaseRefSync` to apply empty base refs instead of skipping them.
- Update the base ref pill in the top bar to show a prompt (e.g. "select base branch") when empty, opening the existing branch selector.
- Worktree creation already blocks on empty `baseRef`, so starting a task naturally requires picking one first — no change needed there.

**Key files:** `src/workdir/git-utils.ts` (`resolveBaseRefForBranch`), `src/server/project-metadata-monitor.ts` (`checkForBranchChanges`), `web-ui/src/hooks/board/use-task-base-ref-sync.ts`, `src/core/task-board-mutations.ts` (validation), `web-ui/src/components/app/connected-top-bar.tsx` (base ref pill UI).

## Search modals: live preview pane

Add a VS Code-style peek preview to the search modals — when a result is highlighted (keyboard or hover), show a read-only preview of the file content alongside the result list, centered on the matched line. Avoids full navigation for scanning multiple matches. Could be a side panel within the overlay or an expandable inline preview.
