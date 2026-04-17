---
project: file-finder-text-search
date: 2026-04-17
phase: spec
status: draft
---

# SDD: File Finder (Cmd+P) and Text Search (Cmd+Shift+F)

## 1. Overview

Add two VS Code-style search overlays to Quarterdeck's web UI: a file finder (Cmd+P) for fast filename search, and a text search (Cmd+Shift+F) for full-text grep across the workspace. Both open as centered floating panels with keyboard navigation, and selecting a result opens the file in the existing file content viewer.

## 2. Behavioral Change

> **BEFORE**: Users can only browse files via the file browser tree sidebar. There is no way to search file contents across a worktree from the UI.

> **AFTER**: Cmd+P opens a quick-open file finder (fuzzy filename search, debounced 150ms). Cmd+Shift+F opens a text search modal (git grep, fires on Enter, results grouped by file with line numbers and match highlighting). Clicking/selecting a result in either modal opens it in the file content viewer.

> **SCOPE**: Both modals available whenever a workspace is selected (`currentProjectId !== null`). Active in the main board view. File finder uses the existing `workspace.searchFiles` endpoint. Text search uses a new `workspace.searchText` endpoint backed by `git grep`.

## 3. Architecture

### 3.1 Backend: Text Search Endpoint

#### New file: `src/workspace/search-workspace-text.ts`

A single exported function that runs `git grep` against a workspace directory.

```typescript
export async function searchWorkspaceText(
   cwd: string,
   query: string,
   options?: { caseSensitive?: boolean; isRegex?: boolean; limit?: number },
): Promise<RuntimeWorkspaceTextSearchResponse>
```

**git grep command construction:**

```
git grep -rn --null --no-color [-i] [-F | -E] -- <pattern>
```

- `-r`: recursive
- `-n`: line numbers
- `--null`: use NUL byte (`\0`) as separator between filename and line-number:content (avoids ambiguity with colons in file paths)
- `--no-color`: no ANSI escapes
- `-i`: added when `caseSensitive` is `false` (default: `false`)
- `-F`: fixed-string mode (default, when `isRegex` is `false`)
- `-E`: extended regex mode (when `isRegex` is `true`)
- `--`: separator before pattern to prevent flag injection
- Uses `runGit(cwd, args)` from `src/workspace/git-utils.ts`

**Output parsing algorithm:**

With `--null`, `git grep -rn` outputs lines in the format: `<filepath>\0<lineNumber>:<matchedLine>`

1. Split stdout on `\n`, iterate each line.
2. For each line, split on `\0` to extract `filePath` (everything before the NUL). Split the remainder on the first `:` to get `lineNumber` and `lineContent`.
3. Skip lines that don't contain a NUL byte (binary file notices, etc.).
4. Track a running `totalMatches` counter. When it reaches `limit` (default 100), stop parsing and set `truncated = true`.
5. Group matches by file path into an array of `{ path, matches: [{ line, content }] }`.
6. Return `{ query, files: [...], totalMatches, truncated }`.

**Error handling:**

- `git grep` returns exit code 1 when no matches are found. This is not an error -- return `{ query, files: [], totalMatches: 0, truncated: false }`.
- `git grep` returns exit code 2 on actual errors (bad regex, etc.). Throw a `TRPCError` with code `BAD_REQUEST` and the stderr message.
- Other failures from `runGit` (exit code -1, `ok: false`) are treated as empty results.

**Result limiting strategy:**

`git grep` has no built-in total-match-limit flag (`--max-count` is per-file). Limiting happens at the parsing layer: stop appending matches once `totalMatches >= limit`. This means git grep may produce more output than consumed, but the 10MB `maxBuffer` on `runGit` is sufficient for any reasonable codebase.

#### Zod schemas (added to `src/core/api/workspace-files.ts`):

```typescript
export const runtimeWorkspaceTextSearchRequestSchema = z.object({
   query: z.string().min(1).max(500),
   caseSensitive: z.boolean().optional(),
   isRegex: z.boolean().optional(),
   limit: z.number().int().positive().max(500).optional(),
});
export type RuntimeWorkspaceTextSearchRequest = z.infer<typeof runtimeWorkspaceTextSearchRequestSchema>;

export const runtimeWorkspaceTextSearchMatchSchema = z.object({
   line: z.number().int().nonneg(),
   content: z.string(),
});
export type RuntimeWorkspaceTextSearchMatch = z.infer<typeof runtimeWorkspaceTextSearchMatchSchema>;

export const runtimeWorkspaceTextSearchFileSchema = z.object({
   path: z.string(),
   matches: z.array(runtimeWorkspaceTextSearchMatchSchema),
});
export type RuntimeWorkspaceTextSearchFile = z.infer<typeof runtimeWorkspaceTextSearchFileSchema>;

export const runtimeWorkspaceTextSearchResponseSchema = z.object({
   query: z.string(),
   files: z.array(runtimeWorkspaceTextSearchFileSchema),
   totalMatches: z.number().int().nonneg(),
   truncated: z.boolean(),
});
export type RuntimeWorkspaceTextSearchResponse = z.infer<typeof runtimeWorkspaceTextSearchResponseSchema>;
```

#### tRPC wiring

**`src/trpc/app-router-context.ts`** -- add to `workspaceApi`:

```typescript
searchText: (
   scope: RuntimeTrpcWorkspaceScope,
   input: RuntimeWorkspaceTextSearchRequest,
) => Promise<RuntimeWorkspaceTextSearchResponse>;
```

**`src/trpc/workspace-api-changes.ts`**:

1. Add `"searchText"` to the `ChangesOps` type pick.
2. Add implementation in `createChangesOps`:

```typescript
searchText: async (workspaceScope, input) => {
   return await searchWorkspaceText(workspaceScope.workspacePath, input.query, {
      caseSensitive: input.caseSensitive,
      isRegex: input.isRegex,
      limit: input.limit,
   });
},
```

**`src/trpc/workspace-procedures.ts`** -- add procedure to `workspaceRouter`:

```typescript
searchText: workspaceProcedure
   .input(runtimeWorkspaceTextSearchRequestSchema)
   .output(runtimeWorkspaceTextSearchResponseSchema)
   .query(async ({ ctx, input }) => {
      return await ctx.workspaceApi.searchText(ctx.workspaceScope, input);
   }),
```

### 3.2 Frontend: Shared Overlay Shell

Both modals share a common layout pattern. Extract a reusable shell component.

**New file: `web-ui/src/components/search/search-overlay-shell.tsx`**

```typescript
interface SearchOverlayShellProps {
   children: React.ReactNode;
   onDismiss: () => void;
}
```

**Behavior:**

- Renders a full-viewport backdrop (`fixed inset-0 z-50 bg-black/50`) that calls `onDismiss` on click.
- Centers a floating panel (`max-w-2xl w-full max-h-[70vh]` -- dark themed card, rounded, shadow) with click-stop (`e.stopPropagation()` on the panel div).
- Listens for `Escape` key via a `useEffect` with a `keydown` handler on `document`. Calls `onDismiss`. The handler is added with `capture: true` so it fires before `useEscapeHandler` in App.tsx (which handles deselecting tasks).
- No Radix Dialog -- avoids focus trap complications with the hotkey toggle.
- The shell does not manage focus; the consuming component is responsible for auto-focusing its input.

### 3.3 Frontend: File Finder (Cmd+P)

#### Hook: `web-ui/src/hooks/search/use-file-finder.ts`

```typescript
interface UseFileFinderResult {
   query: string;
   setQuery: (q: string) => void;
   results: RuntimeWorkspaceFileSearchMatch[];
   isLoading: boolean;
   selectedIndex: number;
   setSelectedIndex: (i: number) => void;
   handleKeyDown: (e: React.KeyboardEvent) => void;
   confirmSelection: () => void;
}

function useFileFinder(options: {
   workspaceId: string | null;
   onSelect: (filePath: string) => void;
   onDismiss: () => void;
}): UseFileFinderResult
```

**State management:**

- `query: string` (controlled input value)
- `results: RuntimeWorkspaceFileSearchMatch[]` (search results)
- `isLoading: boolean` (request in flight)
- `selectedIndex: number` (keyboard navigation cursor, 0-based, clamped to results length)
- `requestIdRef: React.MutableRefObject<number>` (race condition protection)

**Debounced search:**

Uses `useDebouncedEffect` from `@/utils/react-use` with 150ms delay, keyed on `[query, workspaceId]`. Inside the effect:

1. If `query.trim()` is empty, clear results and return.
2. Increment `requestIdRef.current`, capture as local `requestId`.
3. Set `isLoading = true`.
4. Call `getRuntimeTrpcClient(workspaceId).workspace.searchFiles.query({ query, limit: 50 })`.
5. On response, if `requestId !== requestIdRef.current`, discard (stale).
6. Otherwise, set `results` and `isLoading = false`. Reset `selectedIndex` to 0.
7. On error, if request ID still matches, clear results and set `isLoading = false`.

**Keyboard navigation (`handleKeyDown`):**

- `ArrowDown`: increment `selectedIndex` (mod results.length), prevent default.
- `ArrowUp`: decrement `selectedIndex` (mod results.length), prevent default.
- `Enter`: call `confirmSelection()`, prevent default.
- `Escape`: call `onDismiss()`, prevent default.

**`confirmSelection()`:**

If `results[selectedIndex]` exists, call `onSelect(results[selectedIndex].path)`.

#### Component: `web-ui/src/components/search/file-finder-overlay.tsx`

```typescript
interface FileFinderOverlayProps {
   workspaceId: string | null;
   onSelect: (filePath: string) => void;
   onDismiss: () => void;
}
```

**Renders:**

```
<SearchOverlayShell onDismiss={onDismiss}>
   <input autoFocus placeholder="Search files by name..." onKeyDown={handleKeyDown} />
   <div className="overflow-y-auto max-h-[60vh]">
      {results.map((file, i) => (
         <FileFinderResultItem
            key={file.path}
            file={file}
            isSelected={i === selectedIndex}
            onClick={() => { onSelect(file.path) }}
         />
      ))}
      {query && results.length === 0 && !isLoading && <EmptyState />}
   </div>
</SearchOverlayShell>
```

**`FileFinderResultItem`** (inline in the same file or a small sub-component):

- Displays `file.name` (bold) and `file.path` (dimmed, smaller).
- If `file.changed`, shows a small dot indicator.
- Highlighted row when `isSelected` (dark blue/grey background).
- Scrolls into view when selected via keyboard (ref + `scrollIntoView({ block: "nearest" })`).

### 3.4 Frontend: Text Search (Cmd+Shift+F)

#### Hook: `web-ui/src/hooks/search/use-text-search.ts`

```typescript
interface UseTextSearchResult {
   query: string;
   setQuery: (q: string) => void;
   caseSensitive: boolean;
   toggleCaseSensitive: () => void;
   isRegex: boolean;
   toggleIsRegex: () => void;
   results: RuntimeWorkspaceTextSearchFile[];
   totalMatches: number;
   truncated: boolean;
   isLoading: boolean;
   selectedIndex: number;
   setSelectedIndex: (i: number) => void;
   handleKeyDown: (e: React.KeyboardEvent) => void;
   confirmSelection: () => void;
   executeSearch: () => void;
}

function useTextSearch(options: {
   workspaceId: string | null;
   onSelect: (filePath: string) => void;
   onDismiss: () => void;
}): UseTextSearchResult
```

**State management:**

- `query: string` (controlled input)
- `caseSensitive: boolean` (default `false`)
- `isRegex: boolean` (default `false`)
- `results: RuntimeWorkspaceTextSearchFile[]`
- `totalMatches: number`
- `truncated: boolean`
- `isLoading: boolean`
- `selectedIndex: number` (indexes into a flat list of all matches across all files)

**Search execution (`executeSearch`):**

- Triggered by Enter key in the input, or by toggling caseSensitive/isRegex when a query exists (via `useEffect` on `[caseSensitive, isRegex]` with a `lastExecutedQuery` ref to avoid re-searching when no query has been entered yet).
- Minimum query length: 2 characters. If shorter, do nothing.
- Calls `getRuntimeTrpcClient(workspaceId).workspace.searchText.query({ query, caseSensitive, isRegex })`.
- Sets results on success, clears on error.

**Flat index mapping:**

The `selectedIndex` indexes into a flattened list of all matches (across all file groups). A `useMemo` computes `flatMatches: Array<{ path: string; line: number; content: string }>` from the grouped `results`. This makes keyboard navigation straightforward: ArrowDown/Up increments/decrements the flat index.

**Keyboard navigation (`handleKeyDown`):**

- `ArrowDown`: increment `selectedIndex` (clamped to `flatMatches.length - 1`), prevent default.
- `ArrowUp`: decrement `selectedIndex` (min 0), prevent default.
- `Enter`: if input is focused, call `executeSearch()`. If a result is selected (input not focused, or `selectedIndex >= 0` and results exist), call `confirmSelection()`.
- `Escape`: call `onDismiss()`.

**Decision for Enter handling:**

Enter always calls `executeSearch()` first. After results appear, the user clicks a result or uses arrow keys + Enter. When `selectedIndex >= 0` and `flatMatches.length > 0`, Enter calls `confirmSelection()`. Otherwise, Enter calls `executeSearch()`. Track this with a `hasSearched` boolean that flips after first search execution.

**`confirmSelection()`:**

If `flatMatches[selectedIndex]` exists, call `onSelect(flatMatches[selectedIndex].path)`.

#### Component: `web-ui/src/components/search/text-search-overlay.tsx`

```typescript
interface TextSearchOverlayProps {
   workspaceId: string | null;
   onSelect: (filePath: string) => void;
   onDismiss: () => void;
}
```

**Renders:**

```
<SearchOverlayShell onDismiss={onDismiss}>
   <div className="flex items-center gap-2">
      <input autoFocus placeholder="Search text in files..." onKeyDown={handleKeyDown} />
      <ToggleButton active={caseSensitive} onClick={toggleCaseSensitive} title="Match Case">Aa</ToggleButton>
      <ToggleButton active={isRegex} onClick={toggleIsRegex} title="Use Regex">.*</ToggleButton>
   </div>
   {totalMatches > 0 && (
      <div className="text-xs text-zinc-400 px-3 py-1">
         {totalMatches} matches in {results.length} files{truncated ? " (results truncated)" : ""}
      </div>
   )}
   <div className="overflow-y-auto max-h-[55vh]">
      {results.map(fileGroup => (
         <div key={fileGroup.path}>
            <div className="file-header">{fileGroup.path} ({fileGroup.matches.length})</div>
            {fileGroup.matches.map((match, matchIdx) => (
               <TextSearchResultLine
                  key={`${fileGroup.path}:${match.line}`}
                  match={match}
                  filePath={fileGroup.path}
                  isSelected={flatIndex === selectedIndex}
                  onClick={() => onSelect(fileGroup.path)}
               />
            ))}
         </div>
      ))}
      {query.length >= 2 && results.length === 0 && !isLoading && <EmptyState />}
   </div>
</SearchOverlayShell>
```

**`TextSearchResultLine`** (inline sub-component):

- Shows line number (dimmed, monospace) and matched line content.
- Match highlighting: if `isRegex` is false, find and highlight all occurrences of `query` in the content using `<mark>` elements. If `isRegex` is true, use `new RegExp(query, caseSensitive ? 'g' : 'gi')` wrapped in try/catch (invalid regex falls back to no highlighting).
- `scrollIntoView({ block: "nearest" })` when selected.

### 3.5 Hotkey Registration

**Modified file: `web-ui/src/hooks/app/use-app-hotkeys.ts`**

Add two new inputs to `UseAppHotkeysInput`:

```typescript
currentProjectId: string | null;
handleToggleFileFinder: () => void;
handleToggleTextSearch: () => void;
```

Add two new `useHotkeys` calls:

```typescript
useHotkeys(
   "mod+p",
   () => {
      if (!currentProjectId) return;
      handleToggleFileFinder();
   },
   {
      enableOnFormTags: true,
      enableOnContentEditable: true,
      preventDefault: true,
   },
   [currentProjectId, handleToggleFileFinder],
);

useHotkeys(
   "mod+shift+f",
   () => {
      if (!currentProjectId) return;
      handleToggleTextSearch();
   },
   {
      enableOnFormTags: true,
      enableOnContentEditable: true,
      preventDefault: true,
   },
   [currentProjectId, handleToggleTextSearch],
);
```

`preventDefault: true` is critical for `mod+p` to suppress the browser print dialog.

### 3.6 State Management

**Modified file: `web-ui/src/App.tsx` (AppContent function)**

Add two boolean state atoms in `AppContent`:

```typescript
const [isFileFinderOpen, setIsFileFinderOpen] = useState(false);
const [isTextSearchOpen, setIsTextSearchOpen] = useState(false);
```

**Toggle handlers** (passed to `useAppHotkeys`):

```typescript
const handleToggleFileFinder = useCallback(() => {
   setIsTextSearchOpen(false); // close text search if open
   setIsFileFinderOpen((prev) => !prev);
}, []);

const handleToggleTextSearch = useCallback(() => {
   setIsFileFinderOpen(false); // close file finder if open
   setIsTextSearchOpen((prev) => !prev);
}, []);
```

**File selection handler** (shared by both overlays):

```typescript
const handleSearchFileSelect = useCallback(
   (filePath: string) => {
      setIsFileFinderOpen(false);
      setIsTextSearchOpen(false);
      git.navigateToFile({ targetView: "files", filePath });
   },
   [git.navigateToFile],
);
```

This uses the existing `navigateToFile` function from `useGitNavigation` (exposed via `GitProvider`), which:
1. Sets `pendingFileNavigation` state.
2. Calls `setMainView("files")`.

`FilesView` already has a `useEffect` that consumes `pendingFileNavigation` and calls `fileBrowserData.onSelectPath(pendingFileNavigation.filePath)`.

**Overlay rendering** (inside the `<div>` that wraps the main layout, after `<AppDialogs>`):

```typescript
{isFileFinderOpen && (
   <FileFinderOverlay
      workspaceId={project.currentProjectId}
      onSelect={handleSearchFileSelect}
      onDismiss={() => setIsFileFinderOpen(false)}
   />
)}
{isTextSearchOpen && (
   <TextSearchOverlay
      workspaceId={project.currentProjectId}
      onSelect={handleSearchFileSelect}
      onDismiss={() => setIsTextSearchOpen(false)}
   />
)}
```

**Project switch cleanup:**

Add `setIsFileFinderOpen(false)` and `setIsTextSearchOpen(false)` to the `handleProjectSwitchStart` callback in `App()`.

## 4. File Changes

| File | Action | Changes |
|------|--------|---------|
| `src/core/api/workspace-files.ts` | Modify | Add 4 new Zod schemas: `runtimeWorkspaceTextSearchRequestSchema`, `runtimeWorkspaceTextSearchMatchSchema`, `runtimeWorkspaceTextSearchFileSchema`, `runtimeWorkspaceTextSearchResponseSchema` and their inferred types |
| `src/workspace/search-workspace-text.ts` | Create | `searchWorkspaceText()` function using `runGit` for `git grep`, with output parsing and result limiting |
| `src/workspace/index.ts` | Modify | Add `export { searchWorkspaceText } from "./search-workspace-text"` |
| `src/trpc/app-router-context.ts` | Modify | Add `searchText` method signature to `workspaceApi` in `RuntimeTrpcContext`, add `RuntimeWorkspaceTextSearchRequest` and `RuntimeWorkspaceTextSearchResponse` to the import list |
| `src/trpc/workspace-api-changes.ts` | Modify | Add `"searchText"` to `ChangesOps` type pick, add implementation in `createChangesOps`, add `searchWorkspaceText` to imports |
| `src/trpc/workspace-procedures.ts` | Modify | Add `searchText` procedure to `workspaceRouter`, add schema imports |
| `web-ui/src/components/search/search-overlay-shell.tsx` | Create | Shared overlay shell: backdrop, centered panel, Escape dismiss, outside-click dismiss |
| `web-ui/src/components/search/file-finder-overlay.tsx` | Create | File finder overlay component using `useFileFinder` hook |
| `web-ui/src/components/search/text-search-overlay.tsx` | Create | Text search overlay component using `useTextSearch` hook |
| `web-ui/src/hooks/search/use-file-finder.ts` | Create | File finder hook: debounced search, request-ID race protection, keyboard navigation |
| `web-ui/src/hooks/search/use-text-search.ts` | Create | Text search hook: search-on-Enter, case/regex toggles, flat-index keyboard nav |
| `web-ui/src/hooks/app/use-app-hotkeys.ts` | Modify | Add `currentProjectId`, `handleToggleFileFinder`, `handleToggleTextSearch` to input interface; add two `useHotkeys` calls for `mod+p` and `mod+shift+f` |
| `web-ui/src/App.tsx` | Modify | Add `isFileFinderOpen`/`isTextSearchOpen` state, toggle handlers, `handleSearchFileSelect`, render overlays, pass new props to `useAppHotkeys`, add cleanup to `handleProjectSwitchStart` |

## 5. Schemas

All schemas are defined in `src/core/api/workspace-files.ts` and exported via the existing barrel `src/core/api/index.ts` (which already has `export * from "./workspace-files.js"`).

### Request

```typescript
export const runtimeWorkspaceTextSearchRequestSchema = z.object({
   query: z.string().min(1).max(500),
   caseSensitive: z.boolean().optional(),
   isRegex: z.boolean().optional(),
   limit: z.number().int().positive().max(500).optional(),
});
```

### Match (per line)

```typescript
export const runtimeWorkspaceTextSearchMatchSchema = z.object({
   line: z.number().int().nonneg(),
   content: z.string(),
});
```

### File group

```typescript
export const runtimeWorkspaceTextSearchFileSchema = z.object({
   path: z.string(),
   matches: z.array(runtimeWorkspaceTextSearchMatchSchema),
});
```

### Response

```typescript
export const runtimeWorkspaceTextSearchResponseSchema = z.object({
   query: z.string(),
   files: z.array(runtimeWorkspaceTextSearchFileSchema),
   totalMatches: z.number().int().nonneg(),
   truncated: z.boolean(),
});
```

## 6. Edge Cases

| Edge case | Handling |
|-----------|----------|
| **Empty query (file finder)** | `useDebouncedEffect` clears results when `query.trim()` is empty. Input shows placeholder "Search files by name...". |
| **Empty / short query (text search)** | `executeSearch` is a no-op when `query.length < 2`. Visual hint: placeholder text "Search text in files... (min 2 chars)". |
| **Very long query strings** | Zod schema caps at 500 characters (`z.string().max(500)`). |
| **No results** | Both overlays show a "No results found" empty state. |
| **git grep exit code 1 (no matches)** | `searchWorkspaceText` returns empty results, not an error. `runGit` returns `{ ok: false, exitCode: 1 }` -- check `exitCode === 1` as the no-match case. |
| **git grep exit code 2 (bad regex)** | Throw `TRPCError({ code: "BAD_REQUEST" })` with the stderr message. The hook catches the error and displays it. |
| **Binary files in git grep output** | git grep outputs `Binary file <path> matches` for binary hits. The parser skips lines that don't match the `file:line:content` pattern. |
| **Special regex characters in non-regex mode** | `-F` (fixed-string) flag is used by default, so special chars are treated literally. |
| **Large number of matches (truncation)** | Parsing stops at 100 matches (default limit). Response includes `truncated: true`. UI shows "(results truncated)" indicator. |
| **Rapid typing in file finder (race conditions)** | `requestIdRef` pattern discards stale responses. Copied from the proven `task-prompt-composer.tsx` pattern. |
| **Both modals open simultaneously** | Toggle handlers close the other modal before opening. Only one can be open at a time. |
| **Workspace switches while modal is open** | `handleProjectSwitchStart` closes both modals. |
| **Modal open with no workspace** | Guard in hotkey handler: `if (!currentProjectId) return;`. The modal components also receive `workspaceId` which may be null -- hooks early-return when null. |
| **Escape key conflict with useEscapeHandler** | `SearchOverlayShell` registers its Escape handler with `capture: true`, so it fires before the bubbling-phase `useEscapeHandler` in App.tsx. The overlay calls `onDismiss` and the event does not propagate to deselect the current task. |
| **File path with colons in git grep output** | `--null` flag uses NUL byte as separator between filename and line-number:content, avoiding all ambiguity. The parser splits on `\0` first, then splits the remainder on the first `:` for line number vs. content. |

## 7. Out of Scope

- **File view history / recent files** -- not included in v1.
- **Scroll-to-line on text search result click** -- the `FileContentViewer` virtualizer could support `scrollToIndex()` but this is a follow-up.
- **Text search context lines** (lines before/after the match) -- the schema could support `contextBefore`/`contextAfter` fields but they are not included in v1.
- **Task-scoped text search** -- v1 always searches the workspace root. Supporting `taskId`/`baseRef` to resolve a task worktree is a follow-up.
- **`grep -rn` fallback for non-git directories** -- Quarterdeck always operates on git repos, so `git grep` is sufficient.
- **Fuzzy matching in file finder** -- the existing `searchWorkspaceFiles` does substring matching with ranking, not fuzzy. Keeping the same behavior for v1. The `fzf` library is available for a future upgrade.

## 8. Functional Verification

1. **File finder -- basic search**: Press Cmd+P -> modal opens with input focused. Type partial filename -> results appear after 150ms debounce. Arrow down/up navigates results (selected row highlighted). Enter opens file in file content viewer (main view switches to "files"). Esc dismisses modal.

2. **File finder -- empty state**: Open Cmd+P -> empty list with placeholder text. No API call until user types.

3. **File finder -- outside click**: Click the backdrop outside the modal panel -> modal dismisses.

4. **File finder -- no workspace**: With no workspace selected (`currentProjectId === null`), pressing Cmd+P does nothing.

5. **Text search -- basic search**: Press Cmd+Shift+F -> modal opens with input focused. Type query, press Enter -> results appear grouped by file with line numbers and highlighted matches. Click a result -> opens file in file content viewer.

6. **Text search -- toggles**: Case sensitivity toggle and regex toggle work. Toggling re-executes search if a query of length >= 2 exists and a search has been executed at least once.

7. **Text search -- result count**: Total match count displayed below the input bar ("42 matches in 7 files").

8. **Text search -- limit**: Results capped at 100 matches by default. When truncated, "(results truncated)" shown.

9. **Text search -- empty/short query**: No search executed for queries shorter than 2 characters.

10. **Text search -- outside click/Esc**: Both dismiss the modal.

11. **Regression -- existing hotkeys**: Cmd+J (terminal), Cmd+G (git history), Cmd+Shift+S (settings) still work. Cmd+P does not trigger browser print dialog.

12. **Regression -- file browser**: File browser tree sidebar still works. `pendingFileNavigation` mechanism is unchanged.

13. **Mutual exclusion**: Opening file finder closes text search and vice versa. Only one overlay is rendered at a time.

---

## Adversarial Review Log

### Pass 1 (Implementer review)

**Issue 1: git grep colon ambiguity.** The initial spec used `:` as the only separator for parsing `git grep -rn` output. File paths containing colons (rare but possible) would break parsing. **Fixed:** Added `--null` flag to use NUL byte separator. Updated the parsing algorithm and edge cases table.

**Issue 2: Text search Enter key ambiguity.** The initial `handleKeyDown` spec was unclear about when Enter triggers search vs. navigates to a result. **Fixed:** Clarified the dual behavior: Enter always executes search first. After results appear and user navigates with arrow keys, Enter on a selected result calls `confirmSelection()`. Added `hasSearched` tracking boolean.

**Issue 3: Colon ambiguity required `--null` flag.** The initial command construction used `:` as the only output separator. **Fixed:** Added `--null` flag directly in the command construction section and updated the parsing algorithm to split on NUL byte first.

**Issue 4: Escape key event propagation.** The overlay's Escape handler would conflict with `useEscapeHandler` in App.tsx. **Fixed:** Specified `capture: true` on the overlay's keydown listener and documented the precedence.

**Issue 5: Missing barrel export.** `search-workspace-text.ts` needs to be exported from `src/workspace/index.ts`. **Fixed:** Added to file changes table.

**Issue 6: Missing project switch cleanup.** When switching projects, open modals should close. **Fixed:** Added `setIsFileFinderOpen(false)` and `setIsTextSearchOpen(false)` to `handleProjectSwitchStart`.

### Pass 2 (Skeptic review)

**Check: Does the spec match ideation?** Verified behavioral change statement, scope, out-of-scope items, constraints, and functional verification steps all align with ideation.md. The spec adds implementation detail but doesn't change intent.

**Check: Implicit assumptions?** The spec assumes `git grep` is available in the PATH. Since Quarterdeck requires git for all operations and `runGit` is used throughout, this is a safe assumption.

**Check: Over-engineering?** The shared `SearchOverlayShell` component is minimal (backdrop + panel + Escape). This is justified because both overlays need identical dismiss behavior. The flat-index approach for text search keyboard nav adds some complexity but is simpler than maintaining per-file-group indices.

**Check: Integration path verified?** The `navigateToFile` -> `pendingFileNavigation` -> `FilesView.useEffect` chain is the established pattern (used by CommitPanel). The spec reuses it exactly. Confirmed the `FilesView` consumption effect checks `targetView === "files"` which matches.

**Check: Component integration rendered in parent?** Both overlays are explicitly rendered in `AppContent` JSX. The hotkey handlers are wired through `useAppHotkeys`. This avoids the forge lesson about standalone components never being rendered.

**Check: Import paths and types.** All imports reference existing modules and follow established patterns. New types are exported via existing barrels. `RuntimeWorkspaceTextSearchRequest`/`Response` types will be auto-available on the frontend via the tRPC client type inference (no manual frontend type file needed).
