# Dev Todo

Ordered hardest-first so broad/high-risk work is at the top and quick follow-ups are lower in the list.

Tracking note:

- The sections at the top of this file are the active backlog.
- Historical completion context belongs in `docs/implementation-log.md`, `CHANGELOG.md`, or `docs/archive/`, not in this active todo list.
- For newly completed user-visible work, remove the active todo item and record the result in `CHANGELOG.md` rather than adding a new struck-through history line here. Add `docs/implementation-log.md` only when the change has high-signal forensic context: architecture or ownership boundaries, persistence/recovery, terminal/session lifecycle, races, dogfooding incidents, broad cross-cutting edits, or non-obvious investigations.

## Architecture follow-ups from the architecture roadmap

Use this section together with:

- [docs/architecture-roadmap.md](./architecture-roadmap.md)
- [docs/task-state-system-stale.md](./task-state-system-stale.md)

These items are broader ownership-boundary refactors that do not yet need full implementation briefs, but they need enough written context that a fresh agent can pick them up without rediscovering the problem from scratch.

- Tighten the remaining project-level ownership seam around `web-ui/src/providers/project-provider.tsx` and `web-ui/src/providers/project-runtime-provider.tsx` so project navigation, runtime ingress, persistence gating, notification projection, and metadata/debug-log exposure do not keep regathering behind one broad context bag. Backlog context: [docs/architecture-roadmap.md#18-projectprovider--project-runtime-ownership-follow-up](./architecture-roadmap.md#18-projectprovider--project-runtime-ownership-follow-up)
- Continue the terminal lifecycle cleanup after the `SessionTransitionController` extraction so `src/terminal/session-manager.ts` owns less indirect lifecycle policy and more explicit registry/composition responsibility. Backlog context: [docs/architecture-roadmap.md#9-terminal-session-manager--lifecycle-boundaries](./architecture-roadmap.md#9-terminal-session-manager--lifecycle-boundaries)

## Additional code-validated refactor backlog

Use this section together with:

- [docs/architecture-roadmap.md](./architecture-roadmap.md)

These are broader architecture refactor targets confirmed against implementation files and worth keeping visible.

- Rework the file browser + diff viewer data pipeline so scope resolution, tree loading, diff/content fetching, and caching are easier to optimize without mixing transport and view policy. Backlog context: [docs/architecture-roadmap.md#16-file-browser--diff-viewer-data-pipeline](./architecture-roadmap.md#16-file-browser--diff-viewer-data-pipeline)
- Build a clearer branch/base-ref UX state model so inferred base refs, pinned refs, integration branches, and detached-head display rules stop acting like isolated fixes. Backlog context: [docs/architecture-roadmap.md#15-branch--base-ref-ux-state-model](./architecture-roadmap.md#15-branch--base-ref-ux-state-model)
- Separate orphan cleanup from session reconciliation more explicitly so session/process drift, stale lock artifacts, orphan worktrees, and dangling state references each have a clearer maintenance boundary. Backlog context: [docs/architecture-roadmap.md#13-orphan-cleanup--reconciliation-boundary](./architecture-roadmap.md#13-orphan-cleanup--reconciliation-boundary)
- Rebuild stalled/unresponsive task detection without PTY-output-driven session-summary writes. The removed watchdog used `lastOutputAt` to avoid false stalled cards during long-running output, but every output chunk updated and fanned out a full runtime session summary; any replacement should use a cheap internal signal or low-frequency health check that does not wake browser notification/project state on idle terminal redraws.
- Investigate hook-activity fanout after the PTY-output hot path is quiet. Activity-only hooks still mutate `latestHookActivity` / `lastHookAt`, emit full session summaries, trigger runtime stream batches, and can refresh browser notification/project state even when no column/count-changing transition happened. Prefer batching or classifying delivery/broadcast after immediate server-side hook ingest rather than delaying permission/review/resume-critical hook processing; if hook bursts are still expensive, also explore a tiny per-task ingest queue/backpressure layer that preserves state-changing hooks immediately while coalescing or dropping superseded activity-only hooks.
- Investigate project-summary refresh fanout from session-summary batches. Runtime session batches currently request project-list refreshes even for non-count-changing summary mutations such as hook activity, resume metadata, or checkpoints; classify summary changes so project count refreshes run for state/column-impacting updates while lightweight activity updates skip the scoreboard rebuild.
- Make supporting LLM features provider-neutral by turning `src/title/llm-client.ts` into a provider-agnostic lightweight-generation client instead of a Bedrock/Anthropic-specific helper. Backlog context: [docs/architecture-roadmap.md#12-shared-llm-client-abstraction](./architecture-roadmap.md#12-shared-llm-client-abstraction)
- Replace broad ignored-path worktree symlinking with an explicit allowlist plus project-level opt-ins. The current denylist protects known mutable build outputs such as `.NET` `bin/`, `obj/`, and `TestResults/`, but the safer long-term contract is to mirror only high-confidence dependency/setup paths like `node_modules` by default and let projects opt into additional ignored paths intentionally.
- Revisit shell terminal minimization after the dedicated terminal lifecycle is more observable and reliable: home/task shell panes currently stop and dispose when closed or when their owning context is left; keeping them live while minimized should preserve that context boundary without resurrecting hidden terminals into blank/loading panes. Consider IDE-style shell terminal tabs, similar to Rider/JetBrains terminals, so persistent shells are explicit, switchable, and easier to manage.
- After the one-time local-state rewrite to `RuntimeTaskSessionSummary.sessionLaunchPath`, remove the temporary legacy `projectPath` read path from `src/core/api/task-session.ts` so the session identity contract only has one field. Backlog context: [docs/architecture-roadmap.md#10-project--worktree-identity-normalization](./architecture-roadmap.md#10-project--worktree-identity-normalization)

## Codex native hooks parity follow-ups

- Revisit Codex subagent hook scoping before declaring full Claude Code parity. Current Codex hook payloads do not reliably identify root-agent vs subagent `Stop` events, so Quarterdeck maps `Stop` to review for main-agent completion while accepting that subagent-heavy Codex sessions can prematurely mark a task review-ready. Track upstream Codex support for a root/subagent discriminator and split or suppress subagent `Stop` once that metadata exists.
- Revisit Codex slash-command lifecycle parity before declaring full Claude Code parity. Native Codex hooks do not expose stable start/finish boundaries for `/compact`, `/resume`, plugin reloads, or future TUI-local slash commands. Quarterdeck treats those as session-maintenance operations rather than agent turns: they should not move review-ready cards to running, but the UI also cannot show a precise in-progress/completed lifecycle for them until Codex exposes compact/slash-command hooks.
- Revisit Codex turn-lifecycle granularity if the native hook API grows beyond tool/user/stop hooks. The deleted wrapper/parser path could infer `task_started`, `turn_aborted`, and `task_complete` from Codex event logs; native hooks are cleaner and launch-scoped, but currently provide less detail for non-tool turn progress and failure attribution.

## File browser and diff viewer performance

The file browser and diff viewer are laggy, especially for tasks with many changed files or large diffs. Investigate and address:

- **First-open latency**: Opening the compare view or uncommitted-changes view for the first time is noticeably slow. Add debug logging to identify where time is spent (git commands, data serialization, WebSocket transfer, React rendering) before optimizing.
- **File browser**: Slow to load and navigate. Profile whether the bottleneck is git command execution (status, ls-files), data transfer over WebSocket, or React rendering. Tree expansion and file selection should feel instant.
- **Diff viewer**: Large diffs cause noticeable UI lag. Full file text (old + new) is sent inline and diff computation happens client-side. Consider server-side diff computation, virtualized rendering for large files, or lazy-loading diffs per file instead of all at once.
- **Interaction between the two**: Selecting a file in the browser triggers a diff load — if this round-trips to the server each time, latency compounds. Consider pre-fetching diffs for visible files or caching previously viewed diffs.
- **Commit from sidebar is slow**: The commit action triggered from the sidebar loads for a while before completing. Profile whether the bottleneck is the git commit itself, pre-commit hooks, diff recomputation after commit, or UI update.
- **Compare tab scroll interruptions**: Server-side sync frequency can make scrolling the compare tab annoying. Investigate whether refreshes are re-rendering/resetting scroll state too aggressively and throttle, debounce, preserve scroll position, or narrow refresh scope as appropriate.

**Broader refactor context:** [docs/architecture-roadmap.md#16-file-browser--diff-viewer-data-pipeline](./architecture-roadmap.md#16-file-browser--diff-viewer-data-pipeline)

## General performance audit

Do a broad performance pass across the app instead of focusing on one known slow surface. Profile startup, project switching, board interactions, task detail navigation, terminal rendering, git/file views, background polling, and WebSocket fanout; identify the highest-impact bottlenecks before choosing targeted fixes.

## Per-task session identity for non-isolated tasks

The client-side trash/untrash/start bugs for non-isolated tasks are fixed — `ensureTaskWorktree` is no longer called (no orphan worktrees), dialog/toast messaging is correct, cleanup is skipped. However, the deeper session-scoping problem remains:

- **Session clobbering**: `--continue` picks the most recent conversation by CWD. Non-isolated tasks sharing the home repo all compete for the same "most recent" session. A warning toast now discloses this limitation on restore and restart, but there's no per-task session targeting.
- **Possible fix**: If Claude Code adds a `--session-id` or `--resume <id>` flag in the future, Quarterdeck could store the session ID per task and resume the correct conversation. Until then, this is a known limitation for non-isolated tasks.
- **Claude resume by session id**: Investigate whether Claude should move from cwd-scoped `--continue` resume behavior to session-id-based resume when available, matching Codex's stored resume-id model. Clarify how this would affect isolated vs non-isolated tasks, trash/untrash, startup resume, and stale/missing session-id fallback behavior.

## Create agent functional testing framework

Build a framework for agents to dogfood Quarterdeck changes through the UI. The system should let an agent launch a test project, interact with the app like a user, drive task creation/terminal/git/file workflows, capture screenshots/logs/state snapshots, and report reproducible failures for functional regression testing.

## Publish to npm

Register the `quarterdeck` package on npm, configure OIDC trusted publishing for the GitHub repo, and do the first publish via the existing `publish.yml` workflow. Once published, update the README install instructions to use `npx quarterdeck` / `npm i -g quarterdeck` instead of the current clone-and-build steps.

## Branch management in git view

Core git-view branch operations have landed. Remaining power-user operations:

- **Interactive rebase** (reorder/squash commits) — Hard to do well in UI, questionable ROI.
- **Tag management** — Less relevant for the agent-worktree workflow.
- **Force push** — Dangerous, but sometimes needed after rebase. Requires confirmation dialog.
- **Revert commit** — Undo a specific commit without rewriting history.

**UI surface areas:**
- Branch context menu in `BranchSelectorPopover`
- Branch context menu in `GitRefsPanel`
- Git view tab bar or toolbar when the operation needs persistent conflict/progress state

## Auto-update base ref when branch changes to an integration branch

When an agent switches branches inside a task worktree, the metadata monitor calls `resolveBaseRefForBranch` to auto-update the card's base ref. If the new branch is an integration branch like `main`, `resolveBaseRefForBranch` returns `null` (it can't find a parent for `main`) and the update is silently skipped — leaving the card with a stale base ref that no longer makes sense.

**Fix:** When `resolveBaseRefForBranch` returns `null`, clear the card's base ref instead of silently keeping the old value. This requires:

- Allow empty-string `baseRef` to mean "unresolved — user needs to pick" (currently `baseRef` is validated as non-empty everywhere: board mutations, worktree creation, API schema).
- Update the monitor's `checkForBranchChanges` to broadcast `""` when resolved is `null`, instead of skipping.
- Update `useTaskBaseRefSync` to apply empty base refs instead of skipping them.
- Update the base ref pill in the top bar to show a prompt (e.g. "select base branch") when empty, opening the existing branch selector.
- Worktree creation already blocks on empty `baseRef`, so starting a task naturally requires picking one first — no change needed there.

**Key files:** `src/workdir/git-utils.ts` (`resolveBaseRefForBranch`), `src/server/project-metadata-monitor.ts` (`checkForBranchChanges`), `web-ui/src/hooks/board/use-task-base-ref-sync.ts`, `src/core/task-board-mutations.ts` (validation), `web-ui/src/components/app/connected-top-bar.tsx` (base ref pill UI).

**Broader refactor context:** [docs/architecture-roadmap.md#15-branch--base-ref-ux-state-model](./architecture-roadmap.md#15-branch--base-ref-ux-state-model)

## Talk to the agent while browsing files

Add a way to send comments or prompts to the active task agent while browsing files and diffs, without leaving the repository/file inspection surface. Consider a workflow similar to compare-tab comments: attach a prompt to the currently viewed file, selection, or diff hunk, then submit it to the task agent with enough context to make the request actionable.

## File browser tabs like JetBrains

Add JetBrains-style file tabs to the repository/file browser experience so users can keep multiple files or diffs open while navigating, switch between recent inspection contexts quickly, and avoid losing their place when moving through the tree.

## Add source-level debug log filtering

Let debug log filtering control what is actually emitted to the console/log sinks, not just what is visually filtered in the UI. Add configurable source/category/level filters so noisy subsystems can be suppressed before they write logs, while preserving enough default signal for debugging production issues.

## Redo Windows support audit

Reassess Windows support end to end. Check path handling, shell/process launch assumptions, PTY behavior, git/worktree operations, symlink strategy, terminal rendering, file watching, scripts, tests, and documentation so Windows limitations are explicit and fixable items are tracked.

## Audit CI/CD and deployment infrastructure

Review the existing GitHub Actions workflows (`ci.yml`, `test.yml`, `publish.yml`), issue templates, CODEOWNERS, and the changelog extraction script. Decide what's still relevant from the upstream fork, what needs updating (e.g. Slack webhook, CODEOWNERS), and whether anything is missing (e.g. automated changelog generation, release notes workflow).

## Rewrite README and refresh demo media

Rewrite the README so it reflects the current product shape, install flow, core workflows, and architecture tradeoffs. Consider generating fresh GIFs or short screen recordings that show the current board, task agent, terminal, git, and file-browsing flows instead of relying on stale screenshots or outdated copy.

## Commit sidebar: Auto-fill commit message on open

Auto-fill a default commit message when the commit sidebar opens (not just via the generate button, which is already implemented). Pre-fill from the task title, diff summary, and optionally agent session context. The message should be fully editable. Consider using the agent's conversation context (why it made changes, not just what changed) to produce better messages than a blind diff summary — this is a differentiator over standard IDE commit message generation.

## Revisit title and summary generation

Take another pass at generated task titles and summaries. Review the prompts, source context, trigger timing, fallback behavior, and editability so generated text is more specific, less generic, and useful in the board without requiring manual cleanup.

## Choose agent harness from create task

Add an agent harness selector button/control to the create-task flow so users can choose the task agent/harness before launching, rather than relying on a global/default agent setting or changing settings out of band. Task cards should also show which harness they are using so mixed-agent boards are easy to scan.

## Refactor settings menu organization

Rework the settings dialog so related controls are easier to scan and understand. Group agent-specific settings together, make the worktree prompt control more obviously a dropdown/selector, and consider accordion sections to minimize rarely used settings without hiding important defaults.

## Search modals: live preview pane

Add a VS Code-style peek preview to the search modals — when a result is highlighted (keyboard or hover), show a read-only preview of the file content alongside the result list, centered on the matched line. Avoids full navigation for scanning multiple matches. Could be a side panel within the overlay or an expandable inline preview.

## Add clarification when multiple worktrees share the same detached HEAD hash

When tasks are created without a feature branch, their worktrees are all detached at the same base commit. The status bar, card branch pill, and branch dropdown all show the same short commit hash, which looks like a bug. Add a tooltip or subtle label at these display points explaining that the worktrees are independent copies detached from the same base ref — changes in one won't affect others. Consider showing "detached from {baseRef}" instead of just the raw hash.

## Explain file-tab vs git-tab dot indicators

Add a tip, tooltip, or small help affordance that explains the difference between the dot indicators on the file tab and git tab. The copy should make clear what each dot means, why they can differ, and what action the user should take from each surface.

## Upstream sync: periodic review of cline/kanban (recurring)

Periodically review the upstream [cline/kanban](https://github.com/cline/kanban) project for recent bug fixes and improvements worth reimplementing. The codebase has diverged significantly (200+ commits, `cline-sdk/` removed entirely) so most changes need reimplementation rather than direct cherry-picks. Roughly half of upstream output is Cline SDK/account work that will never apply; the other half is shared UI/UX where ideas are portable even if code isn't.

**Cadence:** Check weekly-ish. Run `git fetch upstream && git log upstream/main --oneline --since="<last check date>"` and evaluate new commits.
**Tracker:** [docs/upstream-sync.md](upstream-sync.md) — living doc with Adopted / Backlog / Decided against sections. Update it after each review.

## Archive stale docs (recurring)

Periodically read through docs in `docs/` (research, plans, specs, top-level) and archive anything that's for completed work. Clean up stale or outdated documents. Docs accumulate as features ship — this isn't a one-time task.
