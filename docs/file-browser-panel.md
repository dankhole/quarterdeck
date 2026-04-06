# File Browser Panel

A selectable panel in the detail toolbar (alongside "Kanban" and "Changes") that provides a read-only file browser for the active card's worktree.

## Motivation

When reviewing what an agent is doing, you often want to browse the actual file contents — not just the diff. The diff viewer shows _what changed_, but a file browser shows _what's there_. This is useful for:

- Reading files the agent references but didn't modify
- Checking project structure after an agent creates new files
- Quick file lookups without switching to an external editor
- Understanding context around changes without leaving Kanban

## Design

### Where it lives

Add a third `DetailPanelId` option: `"files"`.

The detail toolbar (`detail-toolbar.tsx`) currently toggles between:
- `"kanban"` (LayoutGrid icon) — board/task detail
- `"changes"` (GitCompareArrows icon) — diff viewer

Add:
- `"files"` (FolderOpen icon) — file browser

This matches the existing panel switching pattern: click the toolbar icon, the right panel swaps. Selection persists to localStorage via `DetailActivePanel` (already supports arbitrary string values).

### Layout (mirrors the diff viewer)

```
┌──────────────┬─────────────────────────────────┐
│  File Tree   │  File Content Viewer            │
│              │                                 │
│  src/        │  1  import { foo } from "./bar" │
│  ├── cli.ts  │  2  import { baz } from "./qux" │
│  ├── core/   │  3                              │
│  │   └── …   │  4  export function main() {    │
│  └── index…  │  5    // ...                    │
│              │  6  }                           │
│              │                                 │
│              │                                 │
└──────────────┴─────────────────────────────────┘
```

Two resizable panes (same resize handle pattern as the diff viewer):
1. **File tree** (left) — reuse/adapt `FileTreePanel` from `detail-panels/file-tree-panel.tsx`
2. **File content viewer** (right) — new component, syntax-highlighted read-only view

The file tree / content split ratio should use its own localStorage key (e.g. `DetailFileBrowserTreeRatio`) following the same pattern as `DetailDiffFileTreePanelRatio`.

### Reusable pieces

| Existing code | Reuse for |
|---|---|
| `FileTreePanel` component | Left pane — adapt to show all files (not just changed ones), remove diff stat badges |
| `buildFileTree()` utility | Convert flat file list into nested tree structure |
| `searchWorkspaceFiles()` backend | File listing (git ls-files), already indexed and cached |
| `workspace.searchFiles` tRPC endpoint | Already exists — returns file paths for a workspace |
| Prism syntax highlighting (from diff viewer) | File content syntax highlighting by extension |
| Resize handle pattern (from diff viewer) | Draggable split between tree and content |

## Implementation Plan

### Phase 1: Backend — file content endpoint

**New tRPC procedure:** `workspace.getFileContent`

```typescript
// Input
{ taskId: string, path: string }

// Output
{ content: string, language: string, binary: boolean, size: number }
```

**Location:** Add to `src/trpc/workspace-api.ts` alongside existing workspace procedures.

**Behavior:**
1. Resolve the task's worktree CWD (same as `getChanges` does)
2. Validate the path is within the worktree (prevent path traversal — reject `..` segments and absolute paths)
3. Read the file from disk (`fs.readFile`)
4. Detect binary files (check for null bytes in first 8KB)
5. Return content as UTF-8 string (or `binary: true` with empty content)
6. Cap file size (e.g. 1MB) — return truncation indicator for large files

**Schema:** Add `RuntimeFileContentResponse` to `api-contract.ts`:
```typescript
const RuntimeFileContentResponse = z.object({
   content: z.string(),
   language: z.string(),
   binary: z.boolean(),
   size: z.number(),
   truncated: z.boolean(),
})
```

### Phase 2: Backend — full file listing endpoint

The existing `searchFiles` endpoint is query-based. Add a variant that returns the full file list for tree building.

**New tRPC procedure:** `workspace.listFiles`

```typescript
// Input
{ taskId: string }

// Output
{ files: string[] }   // relative paths from worktree root
```

**Behavior:**
- Calls `searchWorkspaceFiles()` with empty query (or use `git ls-files` directly)
- Returns all tracked + untracked non-ignored files
- Cached per the existing 10s TTL in `searchWorkspaceFiles`

Alternatively, the existing `searchFiles` endpoint could be used with an empty query if it already returns the full list — check behavior first.

### Phase 3: Frontend — file browser panel component

**New file:** `web-ui/src/components/detail-panels/file-browser-panel.tsx`

**Structure:**
```tsx
function FileBrowserPanel({ taskId, workspaceId }: Props) {
   // Fetch full file list
   // Build tree with buildFileTree()
   // Track selected file path
   // Fetch file content on selection
   // Render: FileTreePanel (adapted) + FileContentViewer
}
```

**File tree adaptation:**
- The existing `FileTreePanel` accepts `workspaceFiles: RuntimeWorkspaceFileChange[]` (objects with path + diff stats)
- Option A: Generalize it to accept plain `string[]` paths (simpler interface, no stats)
- Option B: Create a lightweight `FileBrowserTreePanel` that reuses `buildFileTree()` but renders without diff badges
- Prefer Option B to avoid changing the diff viewer's tree component

**New component:** `FileContentViewer`
- **File:** `web-ui/src/components/detail-panels/file-content-viewer.tsx`
- Renders syntax-highlighted file content using Prism (same setup as diff viewer)
- Line numbers in gutter
- Empty state for no selection, loading state, binary file message, truncation notice
- Scroll to top on file change

### Phase 4: Frontend — hook up to detail toolbar

**Changes to `detail-toolbar.tsx`:**
- Add `"files"` to `DetailPanelId` type
- Add third toolbar button with `FolderOpen` icon and "Files" tooltip

**Changes to `card-detail-view.tsx`:**
- Add rendering branch for `activeDetailPanel === "files"`
- Render `FileBrowserPanel` with current task/workspace context
- Follow same expanded/collapsed pattern as the changes panel

**Changes to `use-card-detail-layout.ts`:**
- Add `detailFileBrowserTreeRatio` + setter (mirrors `detailDiffFileTreeRatio`)
- New localStorage key: `DetailFileBrowserTreeRatio`

### Phase 5: Polish

- **Search/filter in file tree:** Add a small search input at the top of the tree pane that filters the file list (client-side, using the already-fetched file list)
- **Keyboard navigation:** Up/down arrows to navigate tree, Enter to open file
- **Breadcrumb path display** above the content viewer showing the selected file path
- **Copy path button** next to the breadcrumb
- **Word wrap toggle** for long lines

## Scoping Notes

- **Read-only.** No editing, no saving. This is a viewer, not an editor.
- **Worktree-scoped.** Shows files for the selected card's worktree only. No browsing the main checkout or other worktrees.
- **Git-tracked files + untracked.** Uses `git ls-files` (same as search), so respects `.gitignore`.
- **No image preview** in v1. Binary files show a "binary file" message. Image preview can be added later.
- **Fits the planned left toolbar vision** (planned-features.md #5). When the JetBrains-style toolbar is built, this panel can migrate from the right detail toolbar to the left tool strip as "File management".

## Security

- Path traversal protection: reject any `path` containing `..` or starting with `/`
- File size cap prevents memory issues from reading huge files
- Only reads from the task's resolved worktree directory — no arbitrary filesystem access
