# File Browser Panel Implementation Plan

## Overview

Add a file browser panel to the detail toolbar — a third panel alongside "Board" and "Changes" — that provides a read-only, syntax-highlighted view of any file in a task's worktree. Includes an expanded full-screen mode mirroring the existing diff expanded pattern.

**Motivation**: The diff viewer shows what changed, but users often need to browse files the agent references but didn't modify, check project structure, or read context around changes without leaving Kanban.

## Current State

- `DetailPanelId` supports `"kanban" | "changes"` (`web-ui/src/resize/use-card-detail-layout.ts:13`)
- Detail toolbar has two buttons: Board and Changes (`web-ui/src/components/detail-panels/detail-toolbar.tsx:53-85`)
- `CardDetailView` (`web-ui/src/components/card-detail-view.tsx:488-605`) renders panels conditionally by `activeDetailPanel`
- `buildFileTree()` (`web-ui/src/utils/file-tree.ts:8-49`) accepts `string[]` and returns `FileTreeNode[]` — reusable as-is
- `FileTreePanel` (`web-ui/src/components/detail-panels/file-tree-panel.tsx:70-131`) is coupled to `RuntimeWorkspaceFileChange[]` with diff stat badges
- PrismJS highlighting utilities exist in `web-ui/src/components/shared/diff-renderer.tsx` — `resolvePrismLanguage()` (line 103), `getHighlightedLineHtml()` (line 132)
- `searchWorkspaceFiles()` (`src/workspace/search-workspace-files.ts:150-205`) returns files for a workspace but is capped at `MAX_LIMIT = 100`
- No `getFileContent` or `listFiles` tRPC procedure exists
- The expanded diff pattern (`isDiffExpanded`) at `card-detail-view.tsx:620-691` provides a template for full-screen file browsing

## Desired End State

- A "Files" button (FolderOpen icon) in the detail toolbar toggles a file browser panel
- The file browser shows a full file tree (left) and syntax-highlighted file content (right)
- Clicking a file in the tree fetches and displays its content
- An expand toggle enters full-screen mode (toolbar/side-panel hidden, Escape to exit)
- Binary files show a message; large files (>1MB) are truncated with a notice
- File tree persists its resize ratio independently per collapsed/expanded mode

## Out of Scope

- File editing or saving — this is read-only
- Image preview — binary files show a message only
- Browsing the main checkout or other worktrees — scoped to the selected card's worktree
- Directory collapse/expand toggles — directories are always expanded (consistent with existing tree)
- File tree search/filter, keyboard navigation, breadcrumb, copy path — deferred to Phase 5 (polish)

## Dependencies

- **Teams**: None — fully self-contained
- **Services**: None — reads from local filesystem via existing worktree infrastructure
- **Data**: None — no migrations
- **Timing**: None — feature-additive, no breaking changes

## Implementation Approach

Reuse existing infrastructure wherever possible:
- **Backend**: Follow the `loadChanges` / `searchFiles` patterns in `workspace-api.ts` for new procedures. Use `resolveTaskCwd()` for worktree path resolution. Model path traversal protection after `resolveAssetPath()` in `server/assets.ts:56`.
- **Frontend**: Reuse `buildFileTree()` for tree structure, PrismJS utilities from `diff-renderer.tsx` for syntax highlighting, existing resize handle pattern for the tree/content split. Create a new `FileBrowserTreePanel` (not modifying the diff viewer's `FileTreePanel`).

---

## Phase 1: Backend — Zod Schemas + tRPC Endpoints

### Overview

Add the API layer: a `listFiles` procedure to get all files in a task's worktree, and a `getFileContent` procedure to read a single file with binary detection and size capping.

### Changes Required

#### 1. Zod schemas

**File**: `src/core/api-contract.ts`
**Changes**: Add new schemas after the existing `runtimeWorkspaceFileSearchResponseSchema` (line 58):

- `runtimeListFilesRequestSchema`: `{ taskId: string, baseRef: string }`
- `runtimeListFilesResponseSchema`: `{ files: string[] }`
- `runtimeFileContentRequestSchema`: `{ taskId: string, baseRef: string, path: string }`
- `runtimeFileContentResponseSchema`: `{ content: string, language: string, binary: boolean, size: number, truncated: boolean }`

Export the inferred types.

#### 2. Raise file listing limit

**File**: `src/workspace/search-workspace-files.ts`
**Changes**:
- Add a new exported function `listAllWorkspaceFiles(cwd: string): Promise<string[]>` that calls `loadFileIndex(cwd)` and returns all file paths (no scoring, no limit). This avoids changing the existing `searchWorkspaceFiles` API contract.
- Alternatively, add an optional `unlimited` parameter — but a separate function is cleaner.

#### 3. File content reader

**File**: `src/workspace/read-workspace-file.ts` (new file)
**Changes**: Create a focused utility:
- `readWorkspaceFile(worktreePath: string, relativePath: string): Promise<RuntimeFileContentResponse>`
- Validates path: reject if contains `..` segments, starts with `/`, or resolves outside `worktreePath` (normalize + containment check, model after `server/assets.ts:56`)
- Reads file with `fs.readFile` (raw buffer first)
- Binary detection: check for null bytes in first 8KB of buffer
- Size cap: 1MB — if exceeded, truncate and set `truncated: true`
- Language detection: extract extension, map to Prism language name (reuse the extension map or a simplified server-side version)
- Return `{ content, language, binary, size, truncated }`

#### 4. Workspace API methods

**File**: `src/trpc/workspace-api.ts`
**Changes**: Add two new methods to `createWorkspaceApi()`:

- `listFiles(workspaceScope, taskId, baseRef)`: Calls `resolveTaskCwd()` then `listAllWorkspaceFiles()`. Follows the pattern of `loadChanges` (line 246) for CWD resolution.
- `getFileContent(workspaceScope, taskId, baseRef, path)`: Calls `resolveTaskCwd()` then `readWorkspaceFile()`. Follows the pattern of `loadChanges` for CWD resolution.

#### 5. tRPC router procedures

**File**: `src/trpc/app-router.ts`
**Changes**: Add two workspace procedures in `runtimeAppRouter` after `searchFiles` (line 376):

- `listFiles`: input `runtimeListFilesRequestSchema`, calls `ctx.workspaceApi.listFiles()`
- `getFileContent`: input `runtimeFileContentRequestSchema`, calls `ctx.workspaceApi.getFileContent()`

#### 6. RuntimeTrpcContext interface

**File**: `src/trpc/app-router.ts`
**Changes**: Add `listFiles` and `getFileContent` method signatures to the `workspaceApi` section of `RuntimeTrpcContext` (around line 179).

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Existing tests pass: `npm run test:fast`
- [ ] Build succeeds: `npm run build`

#### Manual

- [ ] Start a task with a worktree, call `listFiles` via tRPC devtools or curl — returns file paths
- [ ] Call `getFileContent` with a valid path — returns content with correct language
- [ ] Call `getFileContent` with `../etc/passwd` — returns error (path traversal rejected)
- [ ] Call `getFileContent` with a binary file — returns `binary: true`, empty content
- [ ] Call `getFileContent` on a file >1MB — returns `truncated: true`

**Checkpoint**: Pause here for manual verification before proceeding to Phase 2.

---

## Phase 2: Frontend — Detail Panel System Wiring

### Overview

Extend the panel switching system to support a third "files" panel: update the type, add the toolbar button, add localStorage keys, update the layout hook.

### Changes Required

#### 1. DetailPanelId type

**File**: `web-ui/src/resize/use-card-detail-layout.ts`
**Changes**:
- Line 13: Change type to `export type DetailPanelId = "kanban" | "changes" | "files";`
- Add `COLLAPSED_FILE_BROWSER_TREE_RATIO_PREFERENCE` (default `0.25`, clamp `0.12–0.60`) and `EXPANDED_FILE_BROWSER_TREE_RATIO_PREFERENCE` (default `0.16`, clamp `0.12–0.60`)
- In `loadActivePanel()` (line 36): add `"files"` to the valid values check
- In `useCardDetailLayout()`: add `detailFileBrowserTreeRatio` / `setDetailFileBrowserTreeRatio` state pair (mirroring the diff tree ratio pattern at lines 56-87), switching between collapsed and expanded based on a new `isFileBrowserExpanded` parameter

#### 2. LocalStorageKey enum

**File**: `web-ui/src/storage/local-storage-store.ts`
**Changes**:
- Add `DetailFileBrowserTreePanelRatio = "kanban.detail-file-browser-tree-panel-ratio"` to the enum
- Add `DetailExpandedFileBrowserTreePanelRatio = "kanban.detail-expanded-file-browser-tree-panel-ratio"` to the enum
- Add both to `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS` array (line 23)

#### 3. Toolbar button

**File**: `web-ui/src/components/detail-panels/detail-toolbar.tsx`
**Changes**:
- Import `FolderOpen` from `lucide-react`
- Add third `ToolbarButton` after the Changes button (line 82): panel `"files"`, icon `FolderOpen`, label `"Files"`
- No badge needed for the files button

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Web UI tests pass: `npm run web:test`

#### Manual

- [ ] Three toolbar buttons visible: Board, Changes, Files
- [ ] Clicking Files toggles the side panel (opens if closed, closes if already on Files)
- [ ] Panel selection persists across page reloads (localStorage)
- [ ] Layout reset clears the new keys too

**Checkpoint**: Pause here for manual verification before proceeding to Phase 3.

---

## Phase 3: Frontend — FileBrowserPanel + Subcomponents

### Overview

Build the file browser UI: a tree panel (left) showing all worktree files, a content viewer (right) with syntax highlighting, and wire them into `CardDetailView`.

### Changes Required

#### 1. FileBrowserTreePanel

**File**: `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx` (new)
**Changes**:
- Accepts `files: string[] | null`, `selectedPath: string | null`, `onSelectPath: (path: string) => void`, `panelFlex?: string`
- Calls `buildFileTree(files)` from `@/utils/file-tree`
- Renders `FileBrowserTreeRow` (local component) — same structure as `FileTreeRow` in `file-tree-panel.tsx` but without diff stat badges (no `diffStatsByPath` prop)
- Empty state: `FolderOpen` icon with "No files" message (same pattern as `FileTreePanel` line 108)
- Scroll container with `overflow-y: auto`

#### 2. FileContentViewer

**File**: `web-ui/src/components/detail-panels/file-content-viewer.tsx` (new)
**Changes**:
- Accepts `content: string | null`, `language: string`, `binary: boolean`, `truncated: boolean`, `isLoading: boolean`, `filePath: string | null`
- States:
  - No file selected → centered placeholder ("Select a file to view")
  - Loading → `Spinner` component
  - Binary → centered message ("Binary file — cannot display")
  - Truncated → content + yellow banner at top ("File truncated — showing first 1MB")
  - Normal → syntax-highlighted content
- Syntax highlighting:
  - Import `resolvePrismGrammar`, `getHighlightedLineHtml` from `@/components/shared/diff-renderer`
  - Split content into lines, highlight each with `getHighlightedLineHtml(line, grammar, language)`
  - Render with line numbers in a gutter (left column with `text-text-tertiary`, right column with content)
  - Use `dangerouslySetInnerHTML` for highlighted lines (same pattern as `DiffRowText`)
- Styling: `bg-surface-1`, monospace font, `overflow: auto` both axes

#### 3. FileBrowserPanel (orchestrator)

**File**: `web-ui/src/components/detail-panels/file-browser-panel.tsx` (new)
**Changes**:
- Accepts `taskId: string`, `baseRef: string`, `workspaceId: string`, `treePanelFlex: string`, `contentPanelFlex: string`, `onTreeResizeStart: (e: React.MouseEvent) => void`
- Fetches file list via tRPC `workspace.listFiles` query (with appropriate refetch interval or on-mount)
- Tracks `selectedPath` state
- Fetches file content via tRPC `workspace.getFileContent` query (enabled when `selectedPath` is set)
- Renders: `FileBrowserTreePanel` | `ResizeHandle` | `FileContentViewer`
- `ResizeHandle` receives the `onTreeResizeStart` callback (resize logic stays in `CardDetailView`)

#### 4. CardDetailView integration

**File**: `web-ui/src/components/card-detail-view.tsx`
**Changes**:
- Import `FileBrowserPanel`
- Add `isFileBrowserExpanded` state (line ~273, next to `isDiffExpanded`)
- Add file browser tree resize callback (model after diff tree resize at lines 315-338)
- Add rendering branch in the collapsed side panel section (after `activeDetailPanel === "changes"` at line 535):
  ```
  activeDetailPanel === "files" → FileBrowserToolbar + FileBrowserTreePanel + ResizeHandle + FileContentViewer
  ```
- `FileBrowserToolbar`: simple bar with expand/collapse toggle (same pattern as `DiffToolbar` at line 110)
- `isSidePanelOpen` calculation: update to include `"files"` (currently checks `activeDetailPanel !== null`)

#### 5. tRPC client hooks

**File**: Wherever tRPC client hooks are defined (likely `web-ui/src/runtime/` directory)
**Changes**:
- Add `useListFiles(taskId, baseRef)` query hook
- Add `useFileContent(taskId, baseRef, path)` query hook (enabled only when path is non-null)

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Web UI tests pass: `npm run web:test`
- [ ] Build succeeds: `npm run build`

#### Manual

- [ ] Click "Files" toolbar button → file tree loads with all worktree files
- [ ] Click a file in the tree → content appears with syntax highlighting on the right
- [ ] Resize handle between tree and content works correctly (drag right = narrower tree)
- [ ] Binary files show "Binary file" message instead of content
- [ ] Empty worktree shows empty state
- [ ] Switching between Board/Changes/Files panels preserves each panel's state

**Checkpoint**: Pause here for manual verification before proceeding to Phase 4.

---

## Phase 4: Frontend — Expanded File Browser Mode

### Overview

Add full-screen mode for the file browser, mirroring the existing diff expanded pattern: toolbar and side panel hidden, file browser takes full width, Escape to exit.

### Changes Required

#### 1. Expanded state management

**File**: `web-ui/src/components/card-detail-view.tsx`
**Changes**:
- `isFileBrowserExpanded` state already added in Phase 3
- Add `handleToggleFileBrowserExpand` callback (model after `handleToggleDiffExpand` at line 455): close bottom terminal on expand
- Update the Escape key handler (line 404-426): add `isFileBrowserExpanded` check before `isDiffExpanded`
- When `isFileBrowserExpanded`: hide toolbar + side panel (same conditions as diff expanded mode)

#### 2. Expanded rendering branch

**File**: `web-ui/src/components/card-detail-view.tsx`
**Changes**:
- Add an expanded file browser rendering section (model after lines 620-691):
  ```
  isFileBrowserExpanded → FileBrowserToolbar + FileBrowserTreePanel + ResizeHandle + FileContentViewer (full width)
  ```
- The `FileBrowserToolbar` shows a close button (X icon) and expand/collapse toggle (Minimize2/Maximize2)
- File browser tree uses the expanded ratio from `useCardDetailLayout`

#### 3. Layout hook expanded ratio switching

**File**: `web-ui/src/resize/use-card-detail-layout.ts`
**Changes**:
- `detailFileBrowserTreeRatio` already switches between collapsed/expanded based on `isFileBrowserExpanded` (added in Phase 2)
- Verify the ratio switching works correctly when toggling between modes

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Build succeeds: `npm run build`

#### Manual

- [ ] Click expand button in file browser → full-screen mode, toolbar and side panel hidden
- [ ] Press Escape → exits expanded mode, returns to side panel view
- [ ] Bottom terminal closes when entering expanded mode
- [ ] Resize handle works in expanded mode with independent ratio
- [ ] Resize preference for expanded mode persists separately from collapsed mode

**Checkpoint**: Pause here for manual verification before proceeding to Phase 5.

---

## Phase 5: Polish

### Overview

Add quality-of-life features: search/filter in the file tree, keyboard navigation, breadcrumb path display, and copy path button.

### Changes Required

#### 1. File tree search/filter

**File**: `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx`
**Changes**:
- Add a search input at the top of the tree pane (small, with `Search` icon)
- Client-side filter: filter the `files` array before passing to `buildFileTree()`
- Fuzzy or substring match against file paths
- Clear button to reset filter

#### 2. Keyboard navigation

**File**: `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx`
**Changes**:
- Track focused index in the flattened visible file list
- Arrow Up/Down to move focus
- Enter to select the focused file (triggers `onSelectPath`)
- Focus ring styling on the active row

#### 3. Breadcrumb + copy path

**File**: `web-ui/src/components/detail-panels/file-content-viewer.tsx`
**Changes**:
- Show the selected file path as a breadcrumb bar above the content area
- Add a copy-to-clipboard button (Clipboard icon) next to the path
- Use `navigator.clipboard.writeText()` with a `sonner` toast confirmation

#### 4. Word wrap toggle

**File**: `web-ui/src/components/detail-panels/file-content-viewer.tsx`
**Changes**:
- Add a toggle button in the breadcrumb bar for word wrap
- Toggle `white-space: pre-wrap` vs `white-space: pre` on the content container
- Persist preference to localStorage

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Web UI tests pass: `npm run web:test`

#### Manual

- [ ] Type in search box → tree filters to matching files
- [ ] Clear search → full tree restored
- [ ] Arrow keys navigate the tree, Enter opens a file
- [ ] Breadcrumb shows selected file path
- [ ] Copy button copies path to clipboard with toast confirmation
- [ ] Word wrap toggle works and persists across reloads

---

## Risks

- **Large worktrees**: A repo with 10,000+ files could make the tree slow to render. Mitigation: virtualize the tree rendering (react-window) if needed, or lazy-load subtrees. Monitor in Phase 3 and optimize if necessary.
- **Large file content**: Files near the 1MB cap could cause browser jank during Prism highlighting. Mitigation: the 1MB server-side cap limits exposure; consider disabling highlighting above a threshold (e.g. 500KB).
- **File content caching**: Fetching file content on every click could be slow. Mitigation: use tRPC's built-in query caching (staleTime) so re-selecting a file is instant.
- **Concurrent state**: `isDiffExpanded` and `isFileBrowserExpanded` are independent booleans — both could theoretically be true. Mitigation: when one expands, ensure the other is collapsed (mutually exclusive).

## References

- Design doc: `docs/file-browser-panel.md`
- Research doc: `docs/research/2026-04-06-file-browser-and-detail-toolbar-improvements.md`
- GitHub issues: #5 (file browser panel), #7 (detail toolbar improvements)
- Key files:
  - `web-ui/src/resize/use-card-detail-layout.ts:13` — DetailPanelId
  - `web-ui/src/components/detail-panels/detail-toolbar.tsx:53` — toolbar
  - `web-ui/src/components/card-detail-view.tsx:488` — panel rendering
  - `web-ui/src/components/shared/diff-renderer.tsx:103` — Prism utilities
  - `src/trpc/app-router.ts:371` — existing searchFiles procedure
  - `src/workspace/search-workspace-files.ts:150` — file search function
