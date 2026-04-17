---
project: file-finder-text-search
date: 2026-04-17
phase: research
---

# Research: File Finder and Text Search

## Finding 1: Existing `searchWorkspaceFiles` — Full Stack Path

### Backend (runtime)

**Schema** (`src/core/api/workspace-files.ts:58-75`):
```typescript
runtimeWorkspaceFileSearchRequestSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});
runtimeWorkspaceFileSearchResponseSchema = z.object({
  query: z.string(),
  files: z.array(z.object({ path: z.string(), name: z.string(), changed: z.boolean() })),
});
```

**Implementation** (`src/workspace/search-workspace-files.ts`): Uses `git ls-files --cached --others --exclude-standard` to build a file index (5s cache), then does in-process substring matching ranked by: filename-starts-with > path-starts-with > filename-contains > path-contains, with changed files boosted to top. Default limit 20, max 100.

**tRPC procedure** (`src/trpc/workspace-procedures.ts:225-229`): `workspace.searchFiles` is a `workspaceProcedure` query. It delegates to `ctx.workspaceApi.searchFiles()`.

**API implementation** (`src/trpc/workspace-api-changes.ts:238-241`): `searchFiles` calls `searchWorkspaceFiles(workspaceScope.workspacePath, query, input.limit)` — note it always searches the workspace root, not a task worktree.

### Frontend (web-ui)

The only caller is `task-prompt-composer.tsx` (file mention autocomplete). It uses `useDebouncedEffect` from `@/utils/react-use` (wraps `react-use`'s debounce), calling `getRuntimeTrpcClient(workspaceId).workspace.searchFiles.query(...)` directly inside the debounce callback. No `useTrpcQuery` wrapper — it manages request IDs manually for race protection.

**Key takeaway**: The file finder can reuse the exact same `workspace.searchFiles` endpoint. The debounce + request-ID pattern from `task-prompt-composer.tsx` is the reference for the file finder hook.

## Finding 2: Opening a File in FileContentViewer

The `FileContentViewer` (`web-ui/src/components/git/panels/file-content-viewer.tsx`) is a pure presentational component. It receives `content`, `binary`, `truncated`, `isLoading`, `isError`, `filePath`, and `onClose` as props.

The data-fetching layer is `useFileBrowserData` (`web-ui/src/hooks/git/use-file-browser-data.ts`). It exposes:
- `selectedPath: string | null` — the currently viewed file
- `onSelectPath(path: string | null)` — call this to programmatically open a file
- `fileContent: RuntimeFileContentResponse | null` — auto-fetched when `selectedPath` changes

**To open a file programmatically**: Call `fileBrowserData.onSelectPath("path/to/file")`. The hook fetches content via `workspace.getFileContent` and the `FileContentViewer` renders it.

**External navigation pattern**: `FilesView` accepts a `pendingFileNavigation` prop (used by commit panel "Open in File Browser") — an object `{ targetView: "files", filePath: string }`. An `useEffect` consumes it by calling `fileBrowserData.onSelectPath(pendingFileNavigation.filePath)`.

**Integration path for search modals**: When user selects a search result, the modal should:
1. Switch `mainView` to `"files"` (via `setMainView("files")`)
2. Set a pending file navigation that `FilesView` will consume
3. Dismiss the modal

This mirrors the existing commit-panel -> files-view navigation.

## Finding 3: Modal/Overlay Patterns in the App

There are two distinct overlay patterns:

### Pattern A: Radix Dialog (managed state)
Used for Settings, Task Create, Clear Trash, Debug. Open/close state lives in `useAppDialogs` (or `useInteractionsContext`), exposed through `DialogProvider`. Components use `<Dialog open={isOpen} onOpenChange={setIsOpen}>`. This is the **heavyweight** pattern for full-screen dialogs with headers/footers.

### Pattern B: Inline conditional rendering
`GitHistoryView` is rendered conditionally: `git.isGitHistoryOpen && <GitHistoryView ... />` with a simple boolean state toggle. No Radix Dialog wrapper.

### Recommendation for file finder / text search
Neither existing pattern is a good fit. These modals should be **command-palette-style overlays** — floating centered panels with no dialog chrome, dismissing on Escape/outside-click. The best approach is a new component rendered at the App level (like GitHistoryView), with:
- A backdrop div for outside-click dismiss
- Keyboard event handling (Escape to close, arrow keys for navigation)
- No Radix Dialog (avoids focus trap complications with the hotkey that opens it)
- Conditional rendering controlled by simple boolean state (`isFileFinderOpen`, `isTextSearchOpen`)

## Finding 4: Workspace Selection State

The "workspace selected" guard for the hotkeys needs `currentProjectId` (the active workspace ID).

**Available via `useProjectContext()`** (`web-ui/src/providers/project-provider.tsx`):
- `currentProjectId: string | null` — null when no project is loaded
- `hasNoProjects: boolean` — true when the project list is empty

**Available via `useBoardContext()`** (`web-ui/src/providers/board-provider.tsx`):
- `selectedCard: CardSelection | null` — null when no task is selected
- `selectedTaskId: string | null`

**Guard logic**: The modals should be available when `currentProjectId !== null` (a workspace is loaded). The file finder searches the workspace root regardless of task selection. For task-scoped search, the `selectedCard` provides `taskId` and `baseRef` to resolve the worktree path, but for v1 we search the workspace root which is simpler.

In `App.tsx`, both `project.currentProjectId` and `selectedCard` are already available in the component where `useAppHotkeys` is called (lines 290-304).

## Finding 5: SearchSelectDropdown Analysis

`web-ui/src/components/search-select-dropdown.tsx` is a Radix Popover-based dropdown with:
- FZF fuzzy matching (via `fzf` package)
- Keyboard navigation (up/down/enter/escape/home/end)
- Fuzzy highlight rendering
- Option pinning, recommended sections

**Verdict**: Not suitable for direct reuse. It's designed as a button-triggered dropdown (Popover pattern) bound to a trigger element. The file finder needs a **floating centered overlay** opened by a hotkey with no trigger element. However, the keyboard navigation pattern and the fuzzy matching with `fzf` library are excellent references. Extract those patterns into the new component.

## Finding 6: App Hotkeys Pattern

`useAppHotkeys` (`web-ui/src/hooks/app/use-app-hotkeys.ts`) uses `react-hotkeys-hook` v5:

```typescript
useHotkeys("mod+j", handler, {
  enableOnFormTags: true,
  enableOnContentEditable: true,
  preventDefault: true,
}, [dependencies]);
```

Key patterns:
- `mod+` maps to Cmd on Mac, Ctrl on Windows/Linux
- `enableOnFormTags: true` ensures hotkeys work even when an input/textarea is focused
- `preventDefault: true` blocks the browser's default (critical for `mod+p` to suppress the print dialog)
- Conditional logic happens inside the handler, not via `enabled` option
- Dependencies array as 4th argument

**For new hotkeys**: Add `mod+p` and `mod+shift+f` entries in `useAppHotkeys`, both with `enableOnFormTags: true`, `enableOnContentEditable: true`, `preventDefault: true`. Guard inside the handler: `if (!currentProjectId) return;`

**No conflicts**: No existing hotkey uses `mod+p` or `mod+shift+f`.

## Finding 7: tRPC Workspace Procedure Pattern

Adding a new workspace endpoint requires changes in these files:

### 1. Schema (`src/core/api/workspace-files.ts`)
Define Zod request/response schemas and TypeScript types. Follow naming: `runtimeWorkspaceTextSearch{Request|Response}Schema`.

### 2. Barrel export (`src/core/api/index.ts`)
Already exports `workspace-files.ts` via `export *`.

### 3. API context interface (`src/trpc/app-router-context.ts`)
Add the new method to `workspaceApi` in `RuntimeTrpcContext`:
```typescript
searchText: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeWorkspaceTextSearchRequest) => Promise<RuntimeWorkspaceTextSearchResponse>;
```

### 4. API implementation (`src/trpc/workspace-api-changes.ts`)
Add the implementation to the `createChangesOps` return object, under the `ChangesOps` type pick. This is where `searchWorkspaceText(cwd, ...)` gets called.

### 5. Router procedure (`src/trpc/workspace-procedures.ts`)
Add `searchText` procedure to `workspaceRouter`:
```typescript
searchText: workspaceProcedure
  .input(runtimeWorkspaceTextSearchRequestSchema)
  .output(runtimeWorkspaceTextSearchResponseSchema)
  .query(async ({ ctx, input }) => {
    return await ctx.workspaceApi.searchText(ctx.workspaceScope, input);
  }),
```

### 6. `workspaceProcedure` middleware (`src/trpc/app-router-init.ts`)
No changes needed — `workspaceProcedure` already validates workspace scope.

## Finding 8: File Browser Navigation Flow

The complete flow from tree click to content display:

1. `FilesView` passes `fileBrowserData.onSelectPath` to `FileBrowserTreePanel`
2. User clicks a file in the tree -> calls `onSelectPath("path/to/file")`
3. `useFileBrowserData` sets `selectedPath` state + persists to localStorage
4. The `fileContentQueryFn` effect fires (keyed on `selectedPath`)
5. Calls `trpcClient.workspace.getFileContent.query({ taskId, path, ... })`
6. Result flows to `fileContentQuery.data` -> `fileBrowserData.fileContent`
7. `FilesView` passes content props to `FileContentViewer`

**For search result navigation**: The same `onSelectPath` function is the entry point. The search modal needs to:
1. Set mainView to "files" (`setMainView("files")`)
2. Provide the file path via `pendingFileNavigation` (already supported by `FilesView`)

## Finding 9: RuntimeTrpcWorkspaceApi Interface

`RuntimeTrpcContext` (`src/trpc/app-router-context.ts`) defines `workspaceApi` as an inline object type with ~30 methods. Each method takes `(scope: RuntimeTrpcWorkspaceScope, input: ...)` and returns a Promise.

The implementation is split across multiple files (`workspace-api-changes.ts`, potentially others). The `ChangesOps` type in `workspace-api-changes.ts` picks a subset including `searchFiles`, `listFiles`, `getFileContent`. The new `searchText` method should be added to this same `ChangesOps` type pick and implemented in `createChangesOps`.

## Finding 10: Git Grep Execution Pattern

`search-workspace-files.ts` uses `execFile` from `node:child_process` via `promisify`:
```typescript
const execFileAsync = promisify(execFile);
// ...
const [filesResult] = await Promise.all([
  execFileAsync("git", [...args], {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    env: createGitProcessEnv(),
  }),
]);
```

The more general pattern is `runGit` from `src/workspace/git-utils.ts`:
```typescript
export async function runGit(cwd, args, options): Promise<GitCommandResult> {
  const fullArgs = ["-c", "core.quotepath=false", ...args];
  const { stdout, stderr } = await execFileAsync("git", fullArgs, {
    cwd, encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: options.env || createGitProcessEnv(),
  });
}
```

**Recommendation**: Use `runGit` for the `git grep` implementation (already handles error cases, exit codes, `core.quotepath=false`). For the `grep -rn` fallback (non-git directories), use `execFileAsync` directly.

**Path validation**: `validateGitPath(path)` from `src/workspace/git-utils.ts` rejects paths with `..` traversal. The query string for text search should be validated for sanity (non-empty, reasonable length) but doesn't need path validation since it's a search pattern, not a file path.

## Design Recommendation

### Architecture

**Backend**: Add a single new file `src/workspace/search-workspace-text.ts` with a `searchWorkspaceText(cwd, query, options)` function. Use `runGit(cwd, ["grep", "-rn", "--count", ...flags, "--", pattern])` for the primary implementation. Parse `git grep` output (format: `file:line:content`) into structured results grouped by file. Fallback to `grep -rn` if not in a git repo. Add Zod schemas to `src/core/api/workspace-files.ts`. Wire through the standard tRPC workspace procedure pattern (Finding 7).

**Frontend**: Two new overlay components at the App level, each with a custom hook:
1. `FileFinderOverlay` + `useFileFinder` — calls `workspace.searchFiles` with debounce
2. `TextSearchOverlay` + `useTextSearch` — calls `workspace.searchText` on Enter

Both overlays share a common layout pattern (centered floating panel, backdrop, keyboard navigation). Consider a shared `CommandPaletteOverlay` shell component.

Open/close state managed by two booleans in App.tsx (or a new `useSearchOverlays` hook). Hotkeys added to `useAppHotkeys`. File opening via `pendingFileNavigation` prop on `FilesView` + `setMainView("files")`.

### Key decisions
- **File finder searches workspace root**, not task worktree (simpler, matches the existing `searchFiles` behavior). Task-scoped search can be a follow-up.
- **Text search uses `git grep`** with `runGit` helper. No need for the `grep -rn` fallback in v1 since Quarterdeck always operates on git repos.
- **No Radix Dialog** for the overlays — use plain conditional rendering with a backdrop div. This avoids focus trap issues with hotkey toggle behavior.
- **`fzf` library** already available for fuzzy highlighting in file finder results.

## Open Issues

1. **Task-scoped text search**: The `searchFiles` endpoint always searches workspace root. Should `searchText` support a `taskId`/`baseRef` input to resolve a task worktree path (via `tryResolveTaskCwd`)? Recommended: include the schema fields but implement workspace-root-only for v1.
2. **Result limit for git grep**: `git grep` can produce enormous output. The `--max-count` flag limits matches per file, not total. Need to implement truncation at the parsing layer (stop after N total matches). 100 default as stated in ideation.
3. **Scroll-to-line**: Ideation explicitly marks this as out of scope for v1. The `FileContentViewer` doesn't currently support scroll-to-line — the virtualizer could support it via `virtualizer.scrollToIndex()` in a follow-up.
