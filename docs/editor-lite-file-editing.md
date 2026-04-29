# Editor-Lite File Editing Handoff

This note captures the current decision boundary for adding lightweight in-app file editing to Quarterdeck. It is not a full implementation spec. It is meant to let a fresh agent pick up the work without reconstructing the editor-library investigation or accidentally turning the Files view into a separate IDE product.

## Goal

Make small review-time edits possible inside Quarterdeck's existing repository inspection flow.

The intended user flow is:

- browse files and search results in the existing Files surface
- open one or more small text files in tabs
- edit, save, reload, or discard changes
- keep branch/ref browsing read-only
- keep existing Git review, diff, compare, inline-comment, and rollback workflows intact
- create a clean future path for sending a selected code range or diff context to the active task agent

The first milestone should feel like a safe editable worktree browser, not a full IDE.

## Current Recommendation

Use CodeMirror 6 for the first proof of concept.

CodeMirror should be treated as the embedded text editor widget only. It should not own file-browser state, tab state, save state, search orchestration, branch/ref policy, agent actions, or diff/compare behavior.

Monaco remains a viable future replacement if Quarterdeck later needs stronger VS Code-like editor depth. To keep that option real, isolate editor-specific code behind a narrow adapter and keep product state outside the editor component.

Do not pursue a full IDE platform for this work. Quarterdeck already has its own task, terminal, Git review, and file-browser architecture. Re-platforming those surfaces would be a separate product decision, not an editor-lite implementation detail.

## Product Boundary

Keep these surfaces as they are:

- Git `Uncommitted`, `Last Turn`, and `Compare` tabs
- custom diff viewer
- inline diff comments
- rollback actions
- changed-file grouping and review-specific loading behavior
- branch/ref read-only browsing

Evolve the Files surface:

- keep the existing file tree and scope behavior on the left
- replace the right-side read-only text pane, where appropriate, with an editor-first pane
- add file tabs for open text files
- support dirty indicators, save, reload, and close/discard flows
- preserve existing fallbacks for binary, truncated, oversized, and unsupported files

The file browser remains Quarterdeck-owned. CodeMirror does not provide a project tree, Git-aware file list, task/home scoping, branch/ref browsing, text search, or changed-file prioritization.

## Required Modularity

Use an adapter boundary similar to:

```tsx
<SourceEditor
  path={path}
  language={language}
  value={content}
  readOnly={readOnly}
  wordWrap={wordWrap}
  scrollToLine={line}
  onChange={handleChange}
  onSave={handleSave}
  onSelectionChange={handleSelectionChange}
/>
```

The exact props can change, but the ownership split should not:

- `SourceEditor` owns CodeMirror setup, extensions, view lifecycle, theme mapping, and editor events.
- Files/editor workspace state owns open tabs, active path, dirty tracking, save/reload/conflict state, and close prompts.
- Existing file-browser data hooks own file listing, selection, scope, branch/ref mode, and content loading.
- Agent-integration code owns formatting and sending selected context to the task session.

Avoid leaking CodeMirror types through broad app contracts. It is fine for the adapter and nearby editor-extension helpers to know about CodeMirror. Components such as the file tree, search overlays, task detail surfaces, and Git review tabs should not.

This is what keeps a future Monaco swap bounded to the editor adapter and extension layer instead of requiring a rewrite of the Files surface.

## Dependency Guidance

Use official CodeMirror 6 packages directly. Avoid React wrapper packages unless there is a specific, reviewed reason to add one.

Reasons:

- fewer dependencies and less supply-chain surface
- cleaner control over lifecycle and event mapping
- easier to keep CodeMirror behind the adapter boundary
- less risk of wrapper APIs becoming app-level architecture

Follow repo dependency rules:

- no inline or dynamic imports
- use top-level imports
- inspect installed package types rather than guessing
- keep TypeScript strict and avoid `any`
- rerun dependency/security checks before installing or upgrading editor packages

Security snapshot from the investigation: Snyk reported no known direct vulnerabilities for `@codemirror/view` on 2026-04-29, with healthy maintenance. Treat that as a point-in-time check, not a permanent guarantee. Recheck before adding the dependency.

Reference: https://security.snyk.io/package/npm/%40codemirror%2Fview

## Save Boundary

Keep save behavior boring and local-app safe. Do not invent a complex persistence system.

The first save endpoint should:

- write only to the live worktree view
- never write when browsing a `ref` or branch snapshot
- reuse the existing path traversal and symlink escape validation used by worktree file reads
- require the target to resolve to a regular file inside the intended root
- reject binary files
- reject truncated or oversized files
- use a simple content hash or revision check to avoid overwriting changes made by an agent, terminal, or external editor after the file was opened
- use the existing atomic locked-write utility instead of a custom write protocol

This is not meant to be heavyweight sandboxing. It is baseline correctness: do not corrupt files, do not write outside the project, and do not silently stomp concurrent edits.

The first pass can reasonably edit existing small text files only. File create, delete, rename, move, and directory operations can be separate follow-ups.

## Existing Code Anchors

Useful starting points:

- `src/core/api/workdir-files.ts` - runtime file content schemas
- `src/trpc/project-api-changes.ts` - file listing, file search, text search, and file content tRPC handlers
- `src/workdir/read-workdir-file.ts` - current file read limits, binary detection, and path validation
- `src/workdir/search-workdir-files.ts` - file-browser listing and file finder behavior
- `src/workdir/search-workdir-text.ts` - repo text search behavior
- `src/fs/locked-file-system.ts` - locked atomic writes already used elsewhere
- `web-ui/src/hooks/git/use-file-browser-data.ts` - current file-browser data loading and scope behavior
- `web-ui/src/components/git/files-view.tsx` - Files surface composition
- `web-ui/src/components/git/panels/file-browser-tree-panel.tsx` - file tree UI
- `web-ui/src/components/git/panels/file-content-viewer.tsx` - current read-only content viewer, Prism highlighting, markdown preview, binary/truncated states, and scroll-to-line behavior
- `web-ui/src/components/search/file-finder-overlay.tsx` - file finder overlay
- `web-ui/src/components/search/text-search-overlay.tsx` - text search overlay and line navigation
- `web-ui/src/components/git/panels/diff-viewer-panel.tsx` - custom diff/review surface that should remain separate
- `web-ui/src/hooks/git/use-diff-comments.ts` - reference path for formatting review context sent to terminals

Before implementation, read `docs/conventions/web-ui.md`. If the editor workspace hook grows beyond simple React wiring, also read `docs/conventions/frontend-hooks.md` and extract pure state/transition logic into a companion domain module.

## Preserve Current Behavior

The POC should not regress:

- file search opening a path
- text search opening a path and scrolling to a line
- file-tree filtering and expansion behavior
- copy path and copy contents actions
- word wrap preference
- markdown preview, if retained for markdown files
- binary-file display
- truncated-file display
- oversized-file rejection
- branch/ref read-only browsing
- existing diff/compare loading and review interactions

If the editor cannot handle a file safely, fall back to the current viewer-style behavior rather than forcing edit mode.

## Later Extensions

Likely follow-ups once the safe editable pane exists:

- send selected file range to the active task agent
- send current file or current hunk context to the active task agent
- search/replace inside the active file
- richer tab behavior similar to JetBrains-style recent tabs
- file create/delete/rename/move operations
- conflict/merge editing, potentially using an editor-specific merge surface
- language-aware features if real usage justifies Monaco or LSP integration

Do not front-load these into the POC unless the user explicitly asks. The first useful slice is editable text tabs plus safe save/reload behavior.

## Non-Goals For The First Pass

- full language-server management
- debugger integration
- extension marketplace support
- remote/dev-container support
- replacing the custom diff/compare viewer
- replacing the existing file browser
- building a custom editor from textarea/contenteditable primitives
- making Quarterdeck a full IDE shell

## Working Invariant

Quarterdeck owns the repository workflow. CodeMirror owns text editing inside one pane.

If a proposed change makes CodeMirror responsible for repository state, Git review state, task/session behavior, or save policy, push that responsibility back into Quarterdeck-owned hooks/domain modules before continuing.
