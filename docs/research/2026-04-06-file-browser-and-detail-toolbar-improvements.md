# File Browser Panel & Detail Toolbar Improvements

**Date**: 2026-04-06
**Scope**: Planned features #5 (file browser panel) and #7 (detail toolbar / diff viewer improvements)
**Reference**: `docs/file-browser-panel.md` (existing design doc)

---

## 1. Detail Panel System — How It Works Today

### Panel switching (`DetailPanelId`)

**Defined at**: `web-ui/src/resize/use-card-detail-layout.ts:13`

```typescript
export type DetailPanelId = "kanban" | "changes";
```

Two panels exist:
- `"kanban"` — renders `ColumnContextPanel` (mini board view)
- `"changes"` — renders file tree + diff viewer

State is `DetailPanelId | null`. When `null`, the side panel is closed entirely. Clicking the active panel's button closes it (toggles to `null`); clicking a different panel switches to it.

**Toolbar**: `web-ui/src/components/detail-panels/detail-toolbar.tsx`
- Fixed-width vertical sidebar (`TOOLBAR_WIDTH = 40px`, exported at line 6/51)
- Two `ToolbarButton` instances: "Board" (`LayoutGrid` icon) and "Changes" (`GitCompareArrows` icon)
- Changes button shows a red dot badge when `hasUncommittedChanges` is true
- Toolbar is hidden when `isDiffExpanded === true`

**Panel rendering**: `web-ui/src/components/card-detail-view.tsx`
- Top-level layout is a horizontal flex row: Toolbar | Side Panel | Resize Handle | Main Content
- Side panel renders only when `!isDiffExpanded && isSidePanelOpen`
- `activeDetailPanel === "kanban"` → `ColumnContextPanel`
- `activeDetailPanel === "changes"` → `DiffToolbar` + `FileTreePanel` + `ResizeHandle` + `DiffViewerPanel`

### Layout and sizing

**Hook**: `web-ui/src/resize/use-card-detail-layout.ts`

Returns: `activeDetailPanel`, `setActiveDetailPanel`, `sidePanelRatio`, `setSidePanelRatio`, `detailDiffFileTreeRatio`, `setDetailDiffFileTreeRatio`

Three persisted resize preferences:

| Preference | localStorage key | Default | Clamp |
|---|---|---|---|
| Side panel ratio | `kanban.detail-side-panel-ratio` | 0.25 | 0.14–0.45 |
| Collapsed file tree ratio | `kanban.detail-diff-file-tree-panel-ratio` | 0.3333 | 0.12–0.60 |
| Expanded file tree ratio | `kanban.detail-expanded-diff-file-tree-panel-ratio` | 0.16 | 0.12–0.60 |

The hook switches between collapsed/expanded file tree ratios based on `isDiffExpanded`.

### localStorage persistence pattern

**File**: `web-ui/src/storage/local-storage-store.ts`

- `LocalStorageKey` enum defines all storage keys as typed constants
- Detail panel keys: `DetailSidePanelRatio`, `DetailActivePanel`, `DetailDiffFileTreePanelRatio`, `DetailExpandedDiffFileTreePanelRatio`
- Read/write helpers: `readLocalStorageItem()`, `writeLocalStorageItem()`, `removeLocalStorageItem()`
- `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS` array groups all layout keys for reset
- Numeric resize values go through `web-ui/src/resize/resize-preferences.ts` (`loadResizePreference` / `persistResizePreference`) which applies clamping
- Active panel is loaded/persisted directly in the layout hook (empty string = `null`)

---

## 2. Diff Viewer Panel — Structure and Resize

### Component layout

`DiffViewerPanel` (`web-ui/src/components/detail-panels/diff-viewer-panel.tsx`) is **only the diff content pane** (the right side). It is NOT the component that composes the file tree + diff content split.

The split layout is composed in `CardDetailView` (`card-detail-view.tsx`):
```
FileTreePanel | ResizeHandle | DiffViewerPanel
```

### DiffViewerPanel internals
- **Props** (line 536–553): `workspaceFiles`, `selectedPath`, `onSelectedPathChange`, `comments`, `onCommentsChange`, `viewMode`
- Groups files by path using `flattenFilePathsForDisplay()` → `buildFileTree()`
- Each file group renders as a collapsible section with path, +/- stats, chevron toggle
- `viewMode === "split"` → `<SplitDiff>`, otherwise `<UnifiedDiff>`
- Scroll sync: `handleDiffScroll` detects visible file section and syncs `selectedPath`; `scrollToPath` scrolls to a file when selected from tree

### Expanded vs collapsed states

Two expansion axes:

**A. Side panel open/closed** (`activeDetailPanel`):
- `null` → side panel hidden, full space to terminal
- `"changes"` → file tree + diff in side panel at `sidePanelRatio` width

**B. Diff expanded mode** (`isDiffExpanded`):
- **Collapsed**: Changes view in side panel, terminal in main area, unified diff, file tree ratio 0.3333
- **Expanded**: Toolbar and side panel hidden, diff takes full main area, split (side-by-side) diff, file tree ratio 0.16. Escape key exits. Bottom terminal closed on expand.

```
Collapsed (side panel mode):
[Toolbar][FileTree|Handle|DiffContent    |Handle|    AgentTerminal     ]

Expanded (full width mode):
[FileTree|Handle|          SplitDiffContent                            ]
```

### Resize handle system

Three pieces:

1. **`ResizeHandle`** (`web-ui/src/resize/resize-handle.tsx`) — presentational 1px separator with invisible hit area (4px each side), receives `onMouseDown`

2. **`useResizeDrag`** (`web-ui/src/resize/use-resize-drag.ts`) — generic drag hook. On `startDrag(event, config)`: stores config, sets cursor, attaches mousemove/mouseup listeners. On each mousemove, calls `config.onMove(pointerX, event)`.

3. **Resize callbacks in CardDetailView** (lines 289–338):

**Side panel resize** (lines 289–313):
```typescript
const deltaRatio = (pointerX - startX) / containerWidth;
setSidePanelRatio(startRatio + deltaRatio);  // + : drag right = wider
```

**Diff file tree resize** (lines 315–338):
```typescript
const deltaRatio = (pointerX - startX) / containerWidth;
setDetailDiffFileTreeRatio(startRatio - deltaRatio);  // - : drag right = narrower tree
```

The subtraction exists because the file tree is on the LEFT side. Dragging the handle rightward (positive delta) should make the tree narrower (decrease ratio). This is **correct behavior** — dragging toward the content side shrinks the tree, dragging toward the tree side enlarges it.

**User-reported issue**: The user says the resizer "slides the opposite of the way it's dragged." This might refer to the side panel resize handle (between side panel and main content), or there may be a specific context where the inversion feels wrong. The code logic appears mathematically correct for both handles, but the perceived behavior depends on which handle the user is dragging and what they expect to happen.

**Areas to investigate for the inversion bug**:
- The side panel resize handle at line 598–603 (between side panel and main content)
- Whether the container width calculation correctly excludes the toolbar width (line 295: `container.offsetWidth - TOOLBAR_WIDTH`)
- Whether the `containerRef` correctly references the expected DOM element in all expansion states

---

## 3. FileTreePanel

**File**: `web-ui/src/components/detail-panels/file-tree-panel.tsx`

### Props (line 70–80)
- `workspaceFiles: RuntimeWorkspaceFileChange[] | null`
- `selectedPath: string | null`
- `onSelectPath: (path: string) => void`
- `panelFlex?: string` (defaults to `"0.6 1 0"`)

### Data flow
1. Extracts `referencedPaths` (just `.path` strings) from `workspaceFiles`
2. Calls `buildFileTree(referencedPaths)` → sorted `FileTreeNode[]`
3. Builds `diffStatsByPath` lookup (`Record<string, {added, removed}>`)

### FileTreeRow (lines 11–68)
- `<button>` with left padding `depth * 12 + 8` pixels
- `Folder` icon for directories, `FileText` icon for files
- File rows show +/- stats, selected rows get `kb-file-tree-row-selected`
- **Directories are always expanded** — no collapse/expand toggle
- Clicking a directory does nothing (only files trigger `onSelectPath`)

### buildFileTree()

**File**: `web-ui/src/utils/file-tree.ts`

```typescript
interface FileTreeNode {
    name: string;     // segment name ("utils")
    path: string;     // cumulative path ("src/utils")
    type: "file" | "directory";
    children: FileTreeNode[];
}
```

Algorithm: splits paths on `/`, walks segments building/reusing nodes. Last segment = file, intermediates = directory. Sorts: directories before files, then alphabetical by name.

---

## 4. Backend File APIs

### Existing tRPC workspace procedures

**File**: `src/trpc/app-router.ts`

| Procedure | Input | Output | Purpose |
|---|---|---|---|
| `getChanges` (line 347) | `{taskId, baseRef, mode?}` | `{repoRoot, generatedAt, files[]}` | File diffs for a task |
| `searchFiles` (line 371) | `{query, limit?}` | `{query, files[]}` | Search file paths in workspace |
| `getWorkspaceChanges` (line 391) | none | `{repoRoot, generatedAt, files[]}` | Workspace-level changes |
| `getCommitDiff` (line 406) | commit ref | commit diff | Diff for a specific commit |
| `getTaskContext` (line 365) | task info | workspace info | Task worktree context |

**No `getFileContent`, `listFiles`, or `readFile` endpoint exists.** File content only reaches the frontend embedded in `RuntimeWorkspaceFileChange.oldText` / `.newText`.

### searchWorkspaceFiles()

**File**: `src/workspace/search-workspace-files.ts:150`

- Runs `git ls-files --cached --others --exclude-standard` + `git status --porcelain=v1`
- Results cached in-memory for 10 seconds
- Empty query returns all files (changed files first, then alphabetical), truncated to limit
- Non-empty query scores by filename/path match, 4 tiers
- Default limit 20, max 100
- Returns `{ path, name, changed }` per match

### How changes data flows to diff viewer

**File**: `src/workspace/get-workspace-changes.ts`

Three modes:
1. **`getWorkspaceChanges(cwd)`** — HEAD vs working tree. For each changed file, reads `oldText` via `git show HEAD:<path>` and `newText` via `fs.readFile()`. Results cached with LRU (max 128).
2. **`getWorkspaceChangesBetweenRefs()`** — ref-to-ref. Both texts via `git show`.
3. **`getWorkspaceChangesFromRef()`** — ref to working tree. `oldText` from git, `newText` from filesystem.

Full file text (old + new) is sent inline. Diff computation happens client-side.

### Zod types (api-contract.ts)

- `RuntimeWorkspaceFileChange`: `{path, previousPath?, status, additions, deletions, oldText, newText}`
- `RuntimeWorkspaceFileSearchMatch`: `{path, name, changed}`

---

## 5. What Needs to Be Built

### For the file browser panel (feature #5)

**Backend**:
1. **`workspace.listFiles`** procedure — calls `searchWorkspaceFiles()` with empty query but with a higher limit (or no limit). Currently max is 100; may need to raise or bypass for full listings.
2. **`workspace.getFileContent`** procedure — resolves task worktree CWD, validates path (no `..` or absolute paths), reads file via `fs.readFile`, detects binary, caps at 1MB. New Zod schema `RuntimeFileContentResponse`.

**Frontend**:
1. Add `"files"` to `DetailPanelId` type in `use-card-detail-layout.ts:13`
2. Add third `ToolbarButton` in `detail-toolbar.tsx` with `FolderOpen` icon
3. New `FileBrowserPanel` component in `detail-panels/` — fetches full file list, builds tree, fetches file content on selection
4. New `FileContentViewer` component — syntax-highlighted read-only view (reuse Prism from diff viewer)
5. Adapt `buildFileTree()` — already works with plain string arrays, no changes needed
6. Create a `FileBrowserTreePanel` (Option B from design doc) that reuses `buildFileTree()` but renders without diff stat badges
7. Add `DetailFileBrowserTreeRatio` to `LocalStorageKey` enum and `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS`
8. Wire into `card-detail-view.tsx` rendering logic alongside existing panel branches

### For full-screen capability (feature #7)

The expanded diff mode (`isDiffExpanded`) already provides a full-screen-like experience for the changes panel. The file browser panel would need an equivalent:

1. Add `isFileBrowserExpanded` state to `CardDetailView`
2. When expanded: hide toolbar + side panel, render file browser at full width
3. Add expand/collapse toggle button in the file browser toolbar
4. Use same Escape-key-to-exit pattern
5. Create separate localStorage keys for expanded file browser tree ratio

---

## Key Files Reference

| File | Purpose |
|---|---|
| `web-ui/src/resize/use-card-detail-layout.ts` | Layout hook — panel state, ratios, persistence |
| `web-ui/src/resize/resize-handle.tsx` | Presentational resize handle component |
| `web-ui/src/resize/use-resize-drag.ts` | Generic drag session hook |
| `web-ui/src/resize/resize-preferences.ts` | localStorage read/write with clamping |
| `web-ui/src/storage/local-storage-store.ts` | LocalStorageKey enum, read/write/remove helpers |
| `web-ui/src/components/detail-panels/detail-toolbar.tsx` | Vertical toolbar with panel toggle buttons |
| `web-ui/src/components/card-detail-view.tsx` | Main layout compositor — panels, resize handles, expansion |
| `web-ui/src/components/detail-panels/diff-viewer-panel.tsx` | Diff content pane (right side of changes view) |
| `web-ui/src/components/detail-panels/file-tree-panel.tsx` | File tree pane (left side of changes view) |
| `web-ui/src/utils/file-tree.ts` | `buildFileTree()` and `FileTreeNode` type |
| `src/trpc/app-router.ts` | tRPC router with workspace procedures |
| `src/trpc/workspace-api.ts` | Backend workspace API implementation |
| `src/workspace/search-workspace-files.ts` | File search with git ls-files + caching |
| `src/workspace/get-workspace-changes.ts` | Diff generation (reads old/new file text) |
| `src/core/api-contract.ts` | Zod schemas for all API types |
| `docs/file-browser-panel.md` | Existing design doc for file browser panel |
