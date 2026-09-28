# Dev Todo

Ordered hardest-first so broad/high-risk work is at the top and quick follow-ups are lower in the list.

Parallel work ownership, sequencing, and external acceptance gates are tracked in the [backlog execution plan](./backlog-execution-plan.md).

Tracking note:

- The sections at the top of this file are the active backlog.
- Historical completion context belongs in `docs/implementation-log.md`, `CHANGELOG.md`, or tracked `docs/history/`, not in this active todo list.
- For newly completed user-visible work, remove the active todo item and record the result in `CHANGELOG.md` rather than adding a new struck-through history line here. Add `docs/implementation-log.md` only when the change has high-signal forensic context: architecture or ownership boundaries, persistence/recovery, terminal/session lifecycle, races, dogfooding incidents, broad cross-cutting edits, or non-obvious investigations.

## Codex native hooks parity follow-ups

- Revisit and remove the temporary rendered-screen approval shim in `src/terminal/codex-approval-prompt.ts`. Track upstream Codex releases until nested Code Mode approvals reliably emit the structured `PermissionRequest` hook, then verify command, edit, network, permission, and nested-tool approvals before raising Quarterdeck's minimum version and deleting the detector/reset path. The synthetic high-output profile and composer-scan optimization are recorded in the implementation log; real-provider allocation/output-latency acceptance remains open. Keep fallback inspection bounded without broadening it into transcript-based lifecycle inference.
- Revisit remaining Codex slash-command lifecycle parity before declaring full Claude Code parity. Manual `/compact` now uses its dedicated paired hooks as activity-only observations while automatic compaction stays state-neutral, but `/resume`, plugin reloads, and other TUI-local commands still lack stable start/finish boundaries. Keep those unpaired maintenance signals activity-only; they must not move review-ready cards to running.

Externally blocked native-hook capabilities live in [`compatibility-watchlist.md`](./compatibility-watchlist.md), not the active backlog.

## Files view and Git diff performance

The editable Files view uses the newer file tree/editor path, while compare, uncommitted changes, and commit diffs still use the Git diff viewer pipeline. Profile both where dogfood shows lag, especially for tasks with many files or large diffs. The 2026-05-01 profiling pass fixed hidden file-tree/content polling outside the Files surface; remaining work should focus on active Files/Git view latency rather than background non-Files refreshes.

- **First-open latency**: Opening the compare view or uncommitted-changes view for the first time is noticeably slow. Use bounded diagnostic marks and a category-scoped deep-recording window to identify where time is spent (git commands, data serialization, WebSocket transfer, React rendering) before optimizing.
- **Files view end-to-end cost**: The repeated sibling scan in tree construction is fixed. Continue profiling large-repository traversal, tRPC transfer, CodeMirror loading, and active navigation separately from global search scope updates. Hidden surfaces must not resume file polling.
- **Very large diff calculation**: Inline word matching is bounded, unchanged sections are memoized, and offscreen row chunks defer rendering. Exact line matching still runs synchronously, and revealed chunks stay mounted. Profile worker/server-side line computation and full virtualization for files with thousands of unrelated replaced lines, preserving exact line text and review behavior.
- **Files-to-diff interaction**: Compare the newer Files view path with the Git diff viewer path before merging surfaces. Selecting a file in Git diff views now prioritizes that file's diff content over background work; continue profiling remaining selection latency and tune nearby/offscreen prefetch.

If profiling points to mixed ownership rather than a local hot path, keep fixes aligned with the split Files/editor scope, tree, content, and diff-data boundaries rather than folding policy back into a view component.

## Editor-lite follow-ups

The first editable Files-view milestone has landed with CodeMirror tabs, dirty/save/reload/discard behavior, live-worktree-only saves, and basic file/folder create, rename/move, and delete operations. Remaining follow-ups:

- Validate configured LSP servers against real third-party implementations and native Windows. Track optional continuous buffer synchronization, additional templates, shortcuts, and result snippets in the [LSP plan](./lsp-code-navigation-plan.md); request-scoped unsaved-content navigation is implemented.
- Move compare, merge/conflict resolution, commit diff, and other file-viewing surfaces onto the Files/editor foundation where it reduces duplication without losing review-specific workflows. Sequence: [Files and review surface migration](./files-review-surface-plan.md).

## Windows native release acceptance

The code-remediation ledger is complete. Before removing the experimental label, confirm the required Windows CI job on the exact committed revision and complete the authenticated real-provider/manual privacy matrix tracked in [Windows Compatibility Todo](./windows-compatibility-todo.md).
