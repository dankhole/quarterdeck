# Dev Todo

Ordered hardest-first so broad/high-risk work is at the top and quick follow-ups are lower in the list.

Tracking note:

- The sections at the top of this file are the active backlog.
- Historical completion context belongs in `docs/implementation-log.md`, `CHANGELOG.md`, or tracked `docs/history/`, not in this active todo list.
- For newly completed user-visible work, remove the active todo item and record the result in `CHANGELOG.md` rather than adding a new struck-through history line here. Add `docs/implementation-log.md` only when the change has high-signal forensic context: architecture or ownership boundaries, persistence/recovery, terminal/session lifecycle, races, dogfooding incidents, broad cross-cutting edits, or non-obvious investigations.

## Additional code-validated refactor backlog

These are broader architecture refactor targets confirmed against implementation files and worth keeping visible.

- Continue the behavior-preserving foundations for the text-only Remote Companion after the completed board-ownership, lifecycle-reliability, and P2A provider-boundary evidence gates. The immediate next step is P2B: implement provider-neutral recent-conversation reads for Claude and Codex using the selected server-owned bounded raw-history strategy (10 messages by default, 24 maximum), exact stored session identity, canonical root containment, stable native/source-coordinate IDs, typed degradation, and hard lookup/read/response limits. Then add the idempotent non-PTY `TaskInteractionService`, strict leak-tested remote projections, and the browserless acceptance harness before exposing any remote listener. The harness must use Agent Lab's same-state runtime restart—not only browser reconnect—seeded with existing Running, ordinary Review, genuine Needs Input, and Error tasks. Verify cards, notifications, and project pills before task selection, then respond to the recovered Review/Needs Input tasks and verify all three projections converge back to Running; Review remains the full column total while Needs Input is an overlapping signal. Native/structured task conversion remains a separately authorized P3 experiment; it is not part of P2B and the native TUI remains the only execution owner meanwhile. The local input seam requires explicit submit intent but remains a generic local PTY authority, not a remote capability. Live structured JSON may accelerate future updates but is not durable history, and Quarterdeck must not add a second transcript source of truth merely to retain it. Plans: [completed read-source spike and open handoff gate](./conversation-provider-boundary-spike.md) and [Remote Companion](./remote-companion-plan.md).
- Dogfood the new opt-in Claude fullscreen renderer across long conversations, startup/trash resume, automatic restart, pooled attach/detach, alternate-screen restore, mouse scrolling, selection/copy, and links. Keep it default-off until those interactions are stable, then decide whether to make fullscreen the default while retaining the classic-renderer escape hatch. Plan: [docs/claude-terminal-rendering-plan.md](./claude-terminal-rendering-plan.md).
- Rebuild stalled/unresponsive task detection without PTY-output-driven session-summary writes. The removed watchdog used `lastOutputAt` to avoid false stalled cards during long-running output, but every output chunk updated and fanned out a full runtime session summary; any replacement should use a cheap internal signal or low-frequency health check that does not wake browser notification/project state on idle terminal redraws.
- Replace broad ignored-path worktree symlinking with an explicit allowlist plus project-level opt-ins. The current denylist protects mutable dependency trees (`node_modules`) and known build outputs such as `.NET` `bin/`, `obj/`, and `TestResults/`; the safer long-term contract is to mirror only high-confidence immutable setup paths and let projects opt into additional ignored paths intentionally. Installed dependency directories must remain task-owned and are never eligible for sharing.
- Revisit shell terminal minimization after the dedicated terminal lifecycle is more observable and reliable: home/task shell panes currently stop and dispose when closed or when their owning context is left; keeping them live while minimized should preserve that context boundary without resurrecting hidden terminals into blank/loading panes. Consider IDE-style shell terminal tabs, similar to Rider/JetBrains terminals, so persistent shells are explicit, switchable, and easier to manage.

## Codex native hooks parity follow-ups

- Revisit and remove the temporary rendered-screen approval shim in `src/terminal/codex-approval-prompt.ts`. Track upstream Codex releases until nested Code Mode approvals reliably emit the structured `PermissionRequest` hook, then verify command, edit, network, permission, and nested-tool approvals before raising Quarterdeck's minimum version and deleting the detector/reset path. While the shim remains, profile attached high-output Codex sessions for CPU, allocation, and output-latency impact from per-write viewport inspection; optimize if material without broadening the fallback into transcript-based lifecycle inference.
- Revisit remaining Codex slash-command lifecycle parity before declaring full Claude Code parity. Manual `/compact` now uses its dedicated paired hooks while automatic compaction stays state-neutral, but `/resume`, plugin reloads, and other TUI-local commands still lack stable start/finish boundaries. Keep those unpaired maintenance signals activity-only; they must not move review-ready cards to running.
- Revisit Codex turn-failure granularity if the native hook API adds explicit abort/failure events. The current surface covers tool, prompt, compaction, subagent, and stop lifecycle, but the deleted wrapper/parser path could also infer `task_started`, `turn_aborted`, and `task_complete` from event logs. Native hooks remain cleaner and launch-scoped while providing less detail for non-tool failure attribution.

## Files view and Git diff performance

The editable Files view uses the newer file tree/editor path, while compare, uncommitted changes, and commit diffs still use the Git diff viewer pipeline. Profile both where dogfood shows lag, especially for tasks with many files or large diffs. The 2026-05-01 profiling pass fixed hidden file-tree/content polling outside the Files surface; remaining work should focus on active Files/Git view latency rather than background non-Files refreshes.

- **First-open latency**: Opening the compare view or uncommitted-changes view for the first time is noticeably slow. Use bounded diagnostic marks and a category-scoped deep-recording window to identify where time is spent (git commands, data serialization, WebSocket transfer, React rendering) before optimizing.
- **Files view file tree/editor**: Revalidate load/navigation performance on large repositories now that the editable Files view uses `listFiles` and `getFileContent`. Profile whether bottlenecks are git/filesystem traversal, tRPC transfer, CodeMirror loading, or React rendering. Tree expansion and file selection should feel instant. Hidden 5-second file-list polling from Home, Terminal, and Git has been removed, so measure active Files-view cost separately from global search scope updates.
- **Diff viewer**: Large diffs cause noticeable UI lag. Diff content now loads selected and visible files before a capped offscreen prefetch, but old/new file text is still diffed client-side and all file sections still render in one scroll surface. Consider server-side diff computation and virtualized rendering for large files.
- **Files-to-diff interaction**: Compare the newer Files view path with the Git diff viewer path before merging surfaces. Selecting a file in Git diff views now prioritizes that file's diff content over background work; continue profiling remaining selection latency and tune nearby/offscreen prefetch.
- **Commit from sidebar is slow**: The commit action triggered from the sidebar loads for a while before completing. Profile whether the bottleneck is the git commit itself, pre-commit hooks, diff recomputation after commit, or UI update.

If profiling points to mixed ownership rather than a local hot path, keep fixes aligned with the split Files/editor scope, tree, content, and diff-data boundaries rather than folding policy back into a view component.

## Editor-lite follow-ups

The first editable Files-view milestone has landed with CodeMirror tabs, dirty/save/reload/discard behavior, live-worktree-only saves, and basic file/folder create, rename/move, and delete operations. Remaining follow-ups:

- Add bring-your-own LSP code navigation to the Files editor for go-to-definition, find-references, and hover without bundling language servers. Plan: [docs/lsp-code-navigation-plan.md](./lsp-code-navigation-plan.md).
- Add selected-range, file-level, and diff-hunk context actions that can send focused prompts to the active task agent.
- Own the dirty editor-tab cache lifecycle for deleted project/task/worktree scopes so hidden unsaved tabs are surfaced before destructive actions or pruned safely when clean.
- Profile whether the 5 MB soft edit cap needs tuning for generated, minified, or unusually long-line files while preserving the 10 MB display safety cap.
- Keep tuning the CodeMirror dark theme against dogfood feedback and common IDE dark palettes if token families or selections remain too low-contrast.
- Move compare, merge/conflict resolution, commit diff, and other file-viewing surfaces onto the Files/editor foundation where it reduces duplication without losing review-specific workflows.

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

## Windows support follow-ups

The broad audit is complete; current findings live in [docs/windows-support-audit.md](./windows-support-audit.md). Remaining fixable work:

- Add a `windows-latest` CI lane and stabilize the currently skipped Windows test scenarios, especially fake agent command/version probes and launch/open integration smoke coverage.
- Validate and enforce private ACL semantics for diagnostic runtime descriptors, journal segments/manifests, browser-tail equivalents, and exported bundles on Windows; POSIX `0o600`/`0o700` modes alone are not evidence that another local account cannot read them.
- Run a native Windows smoke pass covering install/build, `quarterdeck` launch, Codex/Claude detection, task PTY start/stop, shell terminals, task worktree create/delete, ignored-path junction mirroring, Open in IDE, project shortcuts, and shutdown cleanup.
- Harden Windows shell-string generation for hook and statusline commands so `cmd.exe` metacharacters in paths and arguments are escaped through one shared helper instead of ad hoc double quoting. Open in IDE no longer browser-generates shell text; its typed runtime launcher uses the shared command-shim adapter when Windows requires one.
- Validate ConPTY resize/reconnect/task-restore behavior and decide whether Windows needs a resize-nudge fallback where Unix uses `SIGWINCH`.
- Replace best-effort orphan cleanup with a scoped managed PID registry if native smoke testing shows Windows agent wrappers leave descendants that cannot be identified safely from known executable names or hosted command lines.

## Search modals: live preview pane

Add a VS Code-style peek preview to the search modals — when a result is highlighted (keyboard or hover), show a read-only preview of the file content alongside the result list, centered on the matched line. Avoids full navigation for scanning multiple matches. Could be a side panel within the overlay or an expandable inline preview.

## Upstream sync: periodic review of cline/kanban (recurring)

Periodically review the upstream [cline/kanban](https://github.com/cline/kanban) project for recent bug fixes and improvements worth reimplementing. The codebase has diverged significantly (200+ commits, `cline-sdk/` removed entirely) so most changes need reimplementation rather than direct cherry-picks. Roughly half of upstream output is Cline SDK/account work that will never apply; the other half is shared UI/UX where ideas are portable even if code isn't.

**Cadence:** Check weekly-ish. Run `git fetch upstream && git log upstream/main --oneline --since="<last check date>"` and evaluate new commits.
**Tracker:** [docs/upstream-sync.md](upstream-sync.md) — living doc with Adopted / Backlog / Decided against sections. Update it after each review.

## Archive stale docs (recurring)

Periodically read through docs in `docs/` (research, plans, specs, top-level) and archive anything that's for completed work. Clean up stale or outdated documents. Docs accumulate as features ship — this isn't a one-time task.
