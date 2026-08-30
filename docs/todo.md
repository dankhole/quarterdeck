# Dev Todo

Ordered hardest-first so broad/high-risk work is at the top and quick follow-ups are lower in the list.

Tracking note:

- The sections at the top of this file are the active backlog.
- Historical completion context belongs in `docs/implementation-log.md`, `CHANGELOG.md`, or tracked `docs/history/`, not in this active todo list.
- For newly completed user-visible work, remove the active todo item and record the result in `CHANGELOG.md` rather than adding a new struck-through history line here. Add `docs/implementation-log.md` only when the change has high-signal forensic context: architecture or ownership boundaries, persistence/recovery, terminal/session lifecycle, races, dogfooding incidents, broad cross-cutting edits, or non-obvious investigations.

## Additional code-validated refactor backlog

These are broader architecture refactor targets confirmed against implementation files and worth keeping visible.

- Replace broad ignored-path worktree symlinking with an explicit allowlist plus project-level opt-ins. The current denylist protects mutable dependency trees (`node_modules`) and known build outputs such as `.NET` `bin/`, `obj/`, and `TestResults/`; the safer long-term contract is to mirror only high-confidence immutable setup paths and let projects opt into additional ignored paths intentionally. Installed dependency directories must remain task-owned and are never eligible for sharing.
- Decide whether home/task shell terminals should survive panel minimization and context switching. If persistence is desirable, design explicit IDE-style shell tabs with visible ownership and lifecycle instead of resurrecting hidden terminals into blank/loading panes; otherwise document close/dispose as the intended behavior.

## Codex native hooks parity follow-ups

- Revisit and remove the temporary rendered-screen approval shim in `src/terminal/codex-approval-prompt.ts`. Track upstream Codex releases until nested Code Mode approvals reliably emit the structured `PermissionRequest` hook, then verify command, edit, network, permission, and nested-tool approvals before raising Quarterdeck's minimum version and deleting the detector/reset path. While the shim remains, profile attached high-output Codex sessions for CPU, allocation, and output-latency impact from per-write viewport inspection; optimize if material without broadening the fallback into transcript-based lifecycle inference.
- Revisit remaining Codex slash-command lifecycle parity before declaring full Claude Code parity. Manual `/compact` now uses its dedicated paired hooks as activity-only observations while automatic compaction stays state-neutral, but `/resume`, plugin reloads, and other TUI-local commands still lack stable start/finish boundaries. Keep those unpaired maintenance signals activity-only; they must not move review-ready cards to running.

Externally blocked native-hook capabilities live in [`compatibility-watchlist.md`](./compatibility-watchlist.md), not the active backlog.

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
- Move compare, merge/conflict resolution, commit diff, and other file-viewing surfaces onto the Files/editor foundation where it reduces duplication without losing review-specific workflows.

## Publish to npm

The `quarterdeck` npm name is already held by the maintainer's `0.0.1` placeholder. Configure and confirm npm-side OIDC trusted publishing for the GitHub repository, publish the first real release matching `package.json` through the existing `publish.yml` workflow, then update the README install instructions to use `npx quarterdeck` / `npm i -g quarterdeck` instead of clone-and-build steps.

## Branch management in git view

Core git-view branch operations have landed. Add **Revert commit** so a user can undo a specific commit without rewriting history.

**UI surface areas:**
- Branch context menu in `BranchSelectorPopover`
- Branch context menu in `GitRefsPanel`
- Git view tab bar or toolbar when the operation needs persistent conflict/progress state

## Windows native release acceptance

The code-remediation ledger is complete. Before removing the experimental label, confirm the required Windows CI job on the exact committed revision and complete the authenticated real-provider/manual privacy matrix tracked in [Windows Compatibility Todo](./windows-compatibility-todo.md).

## Search modals: live preview pane

Add a VS Code-style peek preview to the search modals — when a result is highlighted (keyboard or hover), show a read-only preview of the file content alongside the result list, centered on the matched line. Avoids full navigation for scanning multiple matches. Could be a side panel within the overlay or an expandable inline preview.
