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

## Additional code-validated refactor backlog

Use this section together with:

- [docs/architecture-roadmap.md](./architecture-roadmap.md)

These are broader architecture refactor targets confirmed against implementation files and worth keeping visible.

- Rework the Files view file tree/editor data path and Git diff viewer pipeline so scope resolution, tree loading, file-content fetching, diff/content fetching, and caching are easier to optimize without mixing transport and view policy. Backlog context: [docs/architecture-roadmap.md#16-file-browser--diff-viewer-data-pipeline](./architecture-roadmap.md#16-file-browser--diff-viewer-data-pipeline)
- Defer or lazy-initialize pooled task-terminal slots after initial app render. The current app entry calls `initPool()` at module load, which constructs four xterm-backed `TerminalSlot` instances and starts pool timers before the user opens a task terminal. Preserve restore/reuse behavior, warmup TTLs, and dedicated shell-terminal separation when moving this work off the startup hot path.
- Rebuild stalled/unresponsive task detection without PTY-output-driven session-summary writes. The removed watchdog used `lastOutputAt` to avoid false stalled cards during long-running output, but every output chunk updated and fanned out a full runtime session summary; any replacement should use a cheap internal signal or low-frequency health check that does not wake browser notification/project state on idle terminal redraws.
- Investigate hook-activity fanout after the PTY-output hot path is quiet. Activity-only hooks still mutate `latestHookActivity` / `lastHookAt`, emit full session summaries, trigger runtime stream batches, and can refresh browser notification/project state even when no column/count-changing transition happened. The 2026-05-01 profiling pass confirmed `RuntimeStateTaskSessionEventDelivery` currently delivers every coalesced summary batch to active project sessions, cross-project notifications, and project refresh requests. Prefer batching or classifying delivery/broadcast after immediate server-side hook ingest rather than delaying permission/review/resume-critical hook processing; if hook bursts are still expensive, also explore a tiny per-task ingest queue/backpressure layer that preserves state-changing hooks immediately while coalescing or dropping superseded activity-only hooks.
- Investigate project-summary refresh fanout from session-summary batches. Runtime session batches currently request project-list refreshes even for non-count-changing summary mutations such as hook activity, resume metadata, or checkpoints; classify summary changes so project count refreshes run for state/column-impacting updates while lightweight activity updates skip the scoreboard rebuild. Keep notification correctness separate from project scoreboard freshness so approval/review/needs-input changes still fan out immediately.
- Reduce runtime-state WebSocket broadcast serialization overhead. `RuntimeStateClientRegistry` currently calls `JSON.stringify(payload)` inside each client send, so project/all-client broadcasts serialize the same payload once per connected browser. Pre-serialize broadcast frames once per delivery path where it is safe, while preserving per-client close/error cleanup behavior.
- Replace broad ignored-path worktree symlinking with an explicit allowlist plus project-level opt-ins. The current denylist protects known mutable build outputs such as `.NET` `bin/`, `obj/`, and `TestResults/`, but the safer long-term contract is to mirror only high-confidence dependency/setup paths like `node_modules` by default and let projects opt into additional ignored paths intentionally.
- Revisit shell terminal minimization after the dedicated terminal lifecycle is more observable and reliable: home/task shell panes currently stop and dispose when closed or when their owning context is left; keeping them live while minimized should preserve that context boundary without resurrecting hidden terminals into blank/loading panes. Consider IDE-style shell terminal tabs, similar to Rider/JetBrains terminals, so persistent shells are explicit, switchable, and easier to manage.

## Codex native hooks parity follow-ups

- Revisit Codex subagent hook scoping before declaring full Claude Code parity. Current Codex hook payloads do not reliably identify root-agent vs subagent `Stop` events, so Quarterdeck maps `Stop` to review for main-agent completion while accepting that subagent-heavy Codex sessions can prematurely mark a task review-ready. Track upstream Codex support for a root/subagent discriminator and split or suppress subagent `Stop` once that metadata exists.
- Revisit Codex slash-command lifecycle parity before declaring full Claude Code parity. Native Codex hooks do not expose stable start/finish boundaries for `/compact`, `/resume`, plugin reloads, or future TUI-local slash commands. Quarterdeck treats those as session-maintenance operations rather than agent turns: they should not move review-ready cards to running, but the UI also cannot show a precise in-progress/completed lifecycle for them until Codex exposes compact/slash-command hooks.
- Revisit Codex turn-lifecycle granularity if the native hook API grows beyond tool/user/stop hooks. The deleted wrapper/parser path could infer `task_started`, `turn_aborted`, and `task_complete` from Codex event logs; native hooks are cleaner and launch-scoped, but currently provide less detail for non-tool turn progress and failure attribution.

## Files view and Git diff performance

The editable Files view uses the newer file tree/editor path, while compare, uncommitted changes, and commit diffs still use the Git diff viewer pipeline. Profile both where dogfood shows lag, especially for tasks with many files or large diffs. The 2026-05-01 profiling pass fixed hidden file-tree/content polling outside the Files surface; remaining work should focus on active Files/Git view latency rather than background non-Files refreshes.

- **First-open latency**: Opening the compare view or uncommitted-changes view for the first time is noticeably slow. Add debug logging to identify where time is spent (git commands, data serialization, WebSocket transfer, React rendering) before optimizing.
- **Files view file tree/editor**: Revalidate load/navigation performance on large repositories now that the editable Files view uses `listFiles` and `getFileContent`. Profile whether bottlenecks are git/filesystem traversal, tRPC transfer, CodeMirror loading, or React rendering. Tree expansion and file selection should feel instant. Hidden 5-second file-list polling from Home, Terminal, and Git has been removed, so measure active Files-view cost separately from global search scope updates.
- **Diff viewer**: Large diffs cause noticeable UI lag. Diff content now loads selected and visible files before a capped offscreen prefetch, but old/new file text is still diffed client-side and all file sections still render in one scroll surface. Consider server-side diff computation and virtualized rendering for large files.
- **Files-to-diff interaction**: Compare the newer Files view path with the Git diff viewer path before merging surfaces. Selecting a file in Git diff views now prioritizes that file's diff content over background work; continue profiling remaining selection latency and tune nearby/offscreen prefetch.
- **Commit from sidebar is slow**: The commit action triggered from the sidebar loads for a while before completing. Profile whether the bottleneck is the git commit itself, pre-commit hooks, diff recomputation after commit, or UI update.

**Broader refactor context:** [docs/architecture-roadmap.md#16-file-browser--diff-viewer-data-pipeline](./architecture-roadmap.md#16-file-browser--diff-viewer-data-pipeline)

## Editor-lite follow-ups

The first editable Files-view milestone has landed with CodeMirror tabs, dirty/save/reload/discard behavior, live-worktree-only saves, and basic file/folder create, rename/move, and delete operations. Remaining follow-ups:

- Add selected-range, file-level, and diff-hunk context actions that can send focused prompts to the active task agent.
- Own the dirty editor-tab cache lifecycle for deleted project/task/worktree scopes so hidden unsaved tabs are surfaced before destructive actions or pruned safely when clean.
- Profile whether the 5 MB soft edit cap needs tuning for generated, minified, or unusually long-line files while preserving the 10 MB display safety cap.
- Keep tuning the CodeMirror dark theme against dogfood feedback and common IDE dark palettes if token families or selections remain too low-contrast.
- Move compare, merge/conflict resolution, commit diff, and other file-viewing surfaces onto the Files/editor foundation where it reduces duplication without losing review-specific workflows.

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

## Talk to the agent while browsing files

Add a way to send comments or prompts to the active task agent while browsing files and diffs, without leaving the repository/file inspection surface. Consider a workflow similar to compare-tab comments: attach a prompt to the currently viewed file, selection, or diff hunk, then submit it to the task agent with enough context to make the request actionable.

## Add source-level debug log filtering

Let debug log filtering control what is actually emitted to the console/log sinks, not just what is visually filtered in the UI. Add configurable source/category/level filters so noisy subsystems can be suppressed before they write logs, while preserving enough default signal for debugging production issues.

## Windows support follow-ups

The broad audit is complete; current findings live in [docs/windows-support-audit.md](./windows-support-audit.md). Remaining fixable work:

- Add a `windows-latest` CI lane and stabilize the currently skipped Windows test scenarios, especially fake agent command/version probes and launch/open integration smoke coverage.
- Run a native Windows smoke pass covering install/build, `quarterdeck` launch, Codex/Claude/Pi detection, task PTY start/stop, shell terminals, task worktree create/delete, ignored-path junction mirroring, Open in IDE, project shortcuts, and shutdown cleanup.
- Harden Windows shell-string generation for hook, statusline, and Open-in-IDE commands so `cmd.exe` metacharacters in paths and arguments are escaped through one shared helper instead of ad hoc double quoting.
- Validate ConPTY resize/reconnect/task-restore behavior and decide whether Windows needs a resize-nudge fallback where Unix uses `SIGWINCH`.
- Replace best-effort orphan cleanup with a scoped managed PID registry if native smoke testing shows Windows agent wrappers leave descendants that cannot be identified safely from known executable names or hosted command lines.

## Audit CI/CD and deployment infrastructure

Review the existing GitHub Actions workflows (`ci.yml`, `test.yml`, `publish.yml`), issue templates, CODEOWNERS, and the changelog extraction script. Decide what's still relevant from the upstream fork, what needs updating (e.g. Slack webhook, CODEOWNERS), and whether anything is missing (e.g. automated changelog generation, release notes workflow).

## Rewrite README and refresh demo media

Rewrite the README so it reflects the current product shape, install flow, core workflows, and architecture tradeoffs. Consider generating fresh GIFs or short screen recordings that show the current board, task agent, terminal, git, and file-browsing flows instead of relying on stale screenshots or outdated copy.

## Commit sidebar: Auto-fill commit message on open

Auto-fill a default commit message when the commit sidebar opens (not just via the generate button, which is already implemented). Pre-fill from the task title, diff summary, and optionally agent session context. The message should be fully editable. Consider using the agent's conversation context (why it made changes, not just what changed) to produce better messages than a blind diff summary — this is a differentiator over standard IDE commit message generation.

## Search modals: live preview pane

Add a VS Code-style peek preview to the search modals — when a result is highlighted (keyboard or hover), show a read-only preview of the file content alongside the result list, centered on the matched line. Avoids full navigation for scanning multiple matches. Could be a side panel within the overlay or an expandable inline preview.

## Explain file-tab vs git-tab dot indicators

Add a tip, tooltip, or small help affordance that explains the difference between the dot indicators on the file tab and git tab. The copy should make clear what each dot means, why they can differ, and what action the user should take from each surface.

## Upstream sync: periodic review of cline/kanban (recurring)

Periodically review the upstream [cline/kanban](https://github.com/cline/kanban) project for recent bug fixes and improvements worth reimplementing. The codebase has diverged significantly (200+ commits, `cline-sdk/` removed entirely) so most changes need reimplementation rather than direct cherry-picks. Roughly half of upstream output is Cline SDK/account work that will never apply; the other half is shared UI/UX where ideas are portable even if code isn't.

**Cadence:** Check weekly-ish. Run `git fetch upstream && git log upstream/main --oneline --since="<last check date>"` and evaluate new commits.
**Tracker:** [docs/upstream-sync.md](upstream-sync.md) — living doc with Adopted / Backlog / Decided against sections. Update it after each review.

## Archive stale docs (recurring)

Periodically read through docs in `docs/` (research, plans, specs, top-level) and archive anything that's for completed work. Clean up stale or outdated documents. Docs accumulate as features ship — this isn't a one-time task.
