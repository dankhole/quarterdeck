# Task Graph: Git Stash in Commit Panel

**Generated**: 2026-04-12
**Spec**: [spec.md](spec.md)
**Test Spec**: [test-spec.md](test-spec.md)
**Total tasks**: 30 (13 grade-1, 17 grade-2)

## Execution Order

```
T1  Zod schemas (api-contract.ts)
T2  Git stash functions (git-sync.ts)               ── depends on T1
T3  Git stash unit tests                             ── depends on T2
T4  tRPC stash routes (workspace-api.ts)             ── depends on T2
T5  tRPC route registration (app-router.ts)          ── depends on T4
T6  tRPC stash endpoint tests                        ── depends on T5
T7  No-optional-locks test extension                 ── depends on T2
T8  Metadata monitor: homeStashCount                 ── depends on T1
T9  showAppToast action extension                    ── depends on none
T10 Commit panel hook: stash methods                 ── depends on T5
T11 Commit panel UI: stash button + message input    ── depends on T10
T12 Metadata store: homeStashCount selector          ── depends on T8
T13 Stash list hook (use-stash-list.ts)              ── depends on T5, T12
T14 Stash list hook tests                            ── depends on T13
T15 Stash list component (stash-list-section.tsx)    ── depends on T13
T16 Wire stash list into commit panel                ── depends on T15, T12
T17 dirtyTree field: checkout response schema + git-sync ── depends on T1
T18 dirtyTree field: pull response schema + git-sync ── depends on T1
T19 dirtyTree backend tests                          ── depends on T17, T18
T20 Checkout dialog: "Stash & Switch" button         ── depends on T5
T21 Branch actions hook: stashAndCheckout            ── depends on T20
T22 Wire stashAndCheckout into checkout dialog       ── depends on T21
T23 switchHomeBranch: stash & retry toast            ── depends on T9, T17
T24 Git action error dialog: stash & retry props     ── depends on T5
T25 Pull response dirtyTree detection in hook        ── depends on T18, T24
T26 stashAndRetryPull function                       ── depends on T25
T27 Wire stash & pull into App.tsx                   ── depends on T26
T28 Edge case tests (empty stack, stale index, etc.) ── depends on T3
T29 Regression: existing commit/discard tests pass   ── depends on T2, T8
T30 Full integration smoke test                      ── depends on all
```

## Tasks

---

### T1: Add stash Zod schemas and metadata field to api-contract.ts

- **Grade**: 2
- **Status**: done
- **Depends on**: none
- **SDD Phase**: Phase 1 (Backend — Git Stash Operations), Section 1
- **Files to modify**:
  - `src/core/api-contract.ts` — Add `runtimeStashEntrySchema`, `runtimeStashPushRequestSchema`, `runtimeStashActionRequestSchema`, `runtimeStashPushResponseSchema`, `runtimeStashPopApplyResponseSchema`, `runtimeStashDropResponseSchema`, `runtimeStashShowResponseSchema`, `runtimeStashListResponseSchema` with corresponding type exports. Add `homeStashCount: z.number().int().nonnegative()` to `runtimeWorkspaceMetadataSchema`. Do NOT add stashCount to `runtimeTaskWorkspaceMetadataSchema`.
- **Description**: Add all Zod schemas defined in the SDD "Interface Contracts" section after the conflict resolution schemas (~line 308). Add `homeStashCount` field to `runtimeWorkspaceMetadataSchema` (~line 461). Export inferred TypeScript types for each schema. Follow the naming convention of existing schemas (e.g., `runtimeConflictStateSchema`).
- **Acceptance criteria**:
  - [x] `npm run typecheck` passes
  - [x] `npm run build` succeeds
  - [x] All 8 schemas exist with correct field types matching the SDD
  - [x] `RuntimeStashEntry`, `RuntimeStashPushResponse`, `RuntimeStashPopApplyResponse`, `RuntimeStashDropResponse`, `RuntimeStashShowResponse`, `RuntimeStashListResponse` types are exported
  - [x] `runtimeWorkspaceMetadataSchema` includes `homeStashCount` field
  - [x] `runtimeTaskWorkspaceMetadataSchema` is NOT modified
- **Outcome notes**: Two request schemas placed after runtimeTaskWorkspaceInfoRequestSchema due to forward reference. workspace-metadata-monitor.ts updated with homeStashCount: 0 placeholders (createEmptyWorkspaceMetadata + buildWorkspaceMetadataSnapshot).
- **Attempts**: 1 

---

### T2: Implement git stash functions in git-sync.ts

- **Grade**: 2
- **Status**: done
- **Depends on**: T1
- **SDD Phase**: Phase 1 (Backend — Git Stash Operations), Section 2
- **Files to modify**:
  - `src/workspace/git-sync.ts` — Add 7 functions after `discardSingleFile()` (~line 974): `stashPush`, `stashList`, `stashPop`, `stashApply`, `stashDrop`, `stashShow`, `stashCount`
- **Description**: Implement all 7 git stash functions as specified in the SDD Phase 1 Section 2. Key details:
  - `stashPush`: Validate paths via `validateGitPath()`. Build `git stash push --include-untracked` args. If paths non-empty, append `-- ...paths`. If message provided, add `-m <message>`. Return `{ok, error?}`.
  - `stashList`: Use `--format=%gd%x1f%gs%x1f%ci`. Parse `stash@{N}` via regex to extract index. Parse `On <branch>: <message>` or `WIP on <branch>: ...` to extract branch and message. Return `{ok, entries}`.
  - `stashPop`: Run `git stash pop stash@{<index>}`. Detect conflict from exit code + stderr (check for "CONFLICT" or "conflict" in stderr). Return `{ok, conflicted, error?}`.
  - `stashApply`: Same as pop but `git stash apply`. Return `{ok, conflicted, error?}`.
  - `stashDrop`: Run `git stash drop stash@{<index>}`. Return `{ok, error?}`.
  - `stashShow`: Run `git stash show -p stash@{<index>}`. Return `{ok, diff, error?}`.
  - `stashCount`: Run `git --no-optional-locks stash list` and count lines. Return number.
  Follow the `runGit` pattern from `commitSelectedFiles()` at line 865-920.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] All 7 functions exported from `git-sync.ts`
  - [ ] `stashPush` always includes `--include-untracked`
  - [ ] `stashPush` validates paths via `validateGitPath()`
  - [ ] `stashCount` uses `--no-optional-locks`
  - [ ] `stashList` parsing handles both `On <branch>:` and `WIP on <branch>:` formats
- **Outcome notes**: All 7 functions implemented. stashPush validates paths, includes --include-untracked. stashCount uses --no-optional-locks. stashList parses both On/WIP on formats.
- **Attempts**: 1

---

### T3: Write git stash unit tests (git-stash.test.ts)

- **Grade**: 2
- **Status**: done
- **Depends on**: T2
- **SDD Phase**: Phase 1 (Backend — Git Stash Operations)
- **Files to modify**:
  - `test/runtime/git-stash.test.ts` — NEW file. Test cases #1-16 from test spec.
- **Description**: Create `test/runtime/git-stash.test.ts` following the pattern in `test/runtime/git-commit.test.ts`. Use `createTempDir` + `createGitTestEnv` for real git repos. Implement all 16 test cases from the test spec:
  1. `stashPush stashes all changes including untracked`
  2. `stashPush stashes only selected paths`
  3. `stashPush includes custom message`
  4. `stashPush returns error when nothing to stash`
  4b. `stashPush rejects invalid paths via validateGitPath`
  5. `stashList returns empty array for no stashes`
  6. `stashList parses entries with index, message, branch, date`
  7. `stashList handles multiple entries in stack order`
  8. `stashPop restores changes and removes entry`
  9. `stashPop detects conflict and retains entry`
  10. `stashApply restores changes and retains entry`
  11. `stashApply detects conflict and retains entry`
  12. `stashDrop removes entry without applying`
  13. `stashDrop returns error for invalid index`
  14. `stashShow returns diff for stash entry`
  14b. `stashShow returns ok: false with no diff for invalid index`
  15. `stashCount returns 0 for no stashes`
  16. `stashCount returns correct count`
  Follow the test spec for exact setup, action, and assertion details per test.
- **Acceptance criteria**:
  - [ ] `npx vitest run test/runtime/git-stash.test.ts` — all 16 tests pass
  - [ ] Tests use real git repos (not mocks) via `createTempDir`/`createGitTestEnv`
  - [ ] Conflict detection test (#9) verifies stash entry is retained after failed pop
- **Outcome notes**: 
- **Attempts**: 

---

### T4: Add tRPC stash route handlers in workspace-api.ts

- **Grade**: 2
- **Status**: done
- **Depends on**: T2
- **SDD Phase**: Phase 1 (Backend — Git Stash Operations), Section 3
- **Files to modify**:
  - `src/trpc/workspace-api.ts` — Add 6 route handlers: `stashPush` (mutation), `stashList` (query), `stashPop` (mutation), `stashApply` (mutation), `stashDrop` (mutation), `stashShow` (query)
- **Description**: Add tRPC route handlers after the conflict resolution routes. Each handler:
  - Normalizes taskScope to resolve the correct CWD (home repo or task worktree)
  - Calls the corresponding `git-sync.ts` function
  - For mutations (`stashPush`, `stashPop`, `stashApply`, `stashDrop`): broadcasts `void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath)` after success
  - For queries (`stashList`, `stashShow`): just resolve and return
  Follow the `commitSelectedFiles` handler at `workspace-api.ts:504-534` for the taskScope resolution and broadcast pattern. Use the Zod schemas from T1 for input validation.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] All 6 handlers use proper input schemas
  - [ ] Mutations broadcast workspace state update
  - [ ] Queries do not broadcast
- **Outcome notes**: 
- **Attempts**: 

---

### T5: Register stash routes in app-router.ts

- **Grade**: 1
- **Status**: done
- **Depends on**: T4
- **SDD Phase**: Phase 1 (Backend — Git Stash Operations), Section 3
- **Files to modify**:
  - `src/trpc/app-router.ts` — Add method signatures to `RuntimeTrpcContext.workspaceApi` interface; add procedure definitions in the `workspace` router
- **Description**: Register the 6 new stash endpoints in the app router. Add type signatures to the `workspaceApi` interface matching the git-sync function signatures. Add tRPC procedure definitions (`.input()` and `.mutation()`/`.query()`) that call through to `ctx.workspaceApi.stash*` methods. Follow the existing pattern for conflict resolution routes in the same file.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] All 6 endpoints are accessible via the tRPC router
- **Outcome notes**: 
- **Attempts**: 

---

### T6: Write tRPC stash endpoint tests (workspace-api-stash.test.ts)

- **Grade**: 2
- **Status**: done
- **Depends on**: T5
- **SDD Phase**: Phase 1 (Backend — Git Stash Operations)
- **Files to modify**:
  - `test/runtime/trpc/workspace-api-stash.test.ts` — NEW file. Test cases #1-9 from test spec.
- **Description**: Create `test/runtime/trpc/workspace-api-stash.test.ts` following the pattern in `test/runtime/trpc/workspace-api-conflict.test.ts`. Use `vi.mock` for the git-sync module. Implement 9 test cases:
  1. `stashPush resolves task CWD and calls stashPush`
  2. `stashPush uses home repo for null taskScope`
  3. `stashPush broadcasts state update on success` — verify `deps.broadcastRuntimeWorkspaceStateUpdated` called with correct args
  4. `stashList returns entries from git-sync`
  5. `stashPop calls stashPop and broadcasts`
  6. `stashApply calls stashApply and broadcasts`
  7. `stashDrop calls stashDrop and broadcasts`
  8. `stashShow returns diff`
  9. `stash endpoints handle errors gracefully` — verify try/catch fallback
- **Acceptance criteria**:
  - [ ] `npx vitest run test/runtime/trpc/workspace-api-stash.test.ts` — all 9 tests pass
  - [ ] Tests mock git-sync functions (not real git repos)
  - [ ] Broadcast calls are verified for mutations
- **Outcome notes**: 
- **Attempts**: 

---

### T7: Extend no-optional-locks test for stashCount

- **Grade**: 1
- **Status**: done
- **Depends on**: T2
- **SDD Phase**: Phase 1 (Backend — Git Stash Operations)
- **Files to modify**:
  - `test/runtime/git-sync-no-optional-locks.test.ts` — Add assertion that `stashCount` uses `--no-optional-locks` flag
- **Description**: Add a test case to the existing no-optional-locks test file that verifies `stashCount` runs `git --no-optional-locks stash list`. Follow the existing test pattern in the file (likely spying on `runGit` or checking command args). Only `stashCount` needs this — other stash functions are user-initiated mutations that don't need the flag.
- **Acceptance criteria**:
  - [ ] `npx vitest run test/runtime/git-sync-no-optional-locks.test.ts` — all tests pass including the new one
  - [ ] Test specifically verifies `--no-optional-locks` is present in the stashCount command
- **Outcome notes**: 
- **Attempts**: 

---

### T8: Add homeStashCount to metadata monitor

- **Grade**: 2
- **Status**: done
- **Depends on**: T1
- **SDD Phase**: Phase 1 (Backend — Git Stash Operations), Section 4
- **Files to modify**:
  - `src/server/workspace-metadata-monitor.ts` — Modify `loadHomeGitMetadata()`, `buildWorkspaceMetadataSnapshot()`, and `CachedHomeGitMetadata` interface
- **Description**: 
  - Add `stashCount: number` to the `CachedHomeGitMetadata` interface.
  - In `loadHomeGitMetadata()` (~line 218): call `stashCount(workspacePath)` **before** the stateToken comparison. Compare the new stash count against the cached `stashCount`. If only stash count changed (stateToken matches but count differs), bump `stateVersion` and return updated metadata with new count. If stateToken also changed, proceed with full reload as before and include new stash count.
  - In `buildWorkspaceMetadataSnapshot()` (~line 207): include `homeStashCount: entry.homeGit.stashCount` in the returned `RuntimeWorkspaceMetadata` object.
  - Do NOT add stash count to `loadTaskWorkspaceMetadata` — stash is shared across worktrees.
  - Import `stashCount` from `git-sync.ts`.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] `homeStashCount` appears in metadata snapshots
  - [ ] Stash-only changes (e.g., `git stash drop` on clean tree) are detected and bump `stateVersion`
  - [ ] Task workspace metadata is NOT modified
- **Outcome notes**: 
- **Attempts**: 

---

### T9: Extend showAppToast with action button support

- **Grade**: 1
- **Status**: done
- **Depends on**: none
- **SDD Phase**: Phase 4 (Frontend — Stash & Retry for Checkout), Section 5
- **Files to modify**:
  - `web-ui/src/components/app-toaster.ts` — Add optional `action` field to `AppToastProps`, pass through to sonner
- **Description**: Add `action?: { label: string; onClick: () => void }` to the `AppToastProps` interface. In the `showAppToast` function, pass `action` through to the sonner `toast()` options object for all intent variants (`toast.error`, `toast.warning`, `toast.success`, and default `toast`). Sonner natively supports an `action` property with `{ label, onClick }` shape.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [x] `showAppToast` accepts an `action` prop and passes it to sonner
- **Outcome notes**: Sonner ExternalToast type already includes action field — clean pass-through.
- **Attempts**: 1

---

### T10: Add stash methods to commit panel hook (use-commit-panel.ts)

- **Grade**: 2
- **Status**: done
- **Depends on**: T5
- **SDD Phase**: Phase 2 (Frontend — Stash Button in Commit Panel), Section 1
- **Files to modify**:
  - `web-ui/src/hooks/use-commit-panel.ts` — Extend `UseCommitPanelResult` interface and hook body
- **Description**: 
  - Add to `UseCommitPanelResult` interface: `stashChanges: () => Promise<void>`, `isStashing: boolean`, `stashMessage: string`, `setStashMessage: (msg: string) => void`.
  - Add `isStashing` to the `isMutating` union used for polling suppression (~line 49).
  - Implement `stashChanges()`: collect selected paths from the existing file selection state (empty array = stash all), call `trpcClient.workspace.stashPush.mutate({ taskScope, paths, message: stashMessage || undefined })`, show success toast via `showAppToast`, show error toast on failure, clear `stashMessage` on success.
  - Use `useState` for `stashMessage` and `isStashing`.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] `isStashing` is included in `isMutating` for polling suppression (!7)
  - [ ] `stashChanges()` collects selected file paths from existing selection state
  - [ ] Stash message is cleared on success
- **Outcome notes**: 
- **Attempts**: 

---

### T11: Add stash button and message input to commit panel UI

- **Grade**: 2
- **Status**: done
- **Depends on**: T10
- **SDD Phase**: Phase 2 (Frontend — Stash Button in Commit Panel), Section 2
- **Files to modify**:
  - `web-ui/src/components/detail-panels/commit-panel.tsx` — Add stash message input and stash button to the button bar
- **Description**: 
  - Add a small collapsible stash message input that expands when clicked (or a small text input adjacent to the button). Use a minimal UI — perhaps a text input that appears inline when a "message" toggle/icon is clicked, or always visible as a small input above the stash button.
  - Add Stash button between Commit and Discard All in the button bar (~line 267-281): `<Button variant="default" size="sm" disabled={!hasFiles || isStashing} onClick={() => void stashChanges()}>{isStashing ? <Spinner size={14} /> : "Stash"}</Button>`
  - Button disabled when no files or stash in progress.
  - Destructure `stashChanges`, `isStashing`, `stashMessage`, `setStashMessage` from `useCommitPanel` return.
  - Follow the existing Commit button styling pattern.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] Stash button visible in commit panel alongside Commit and Discard All
  - [ ] Button disabled when no uncommitted changes
  - [ ] Spinner shown during stash operation
  - [ ] Stash message input available for optional message
  - [ ] Clicking Stash with files triggers `stashChanges()` (not a no-op `() => {}`)
- **Outcome notes**: 
- **Attempts**: 

---

### T12: Add homeStashCount selector to workspace-metadata-store.ts

- **Grade**: 1
- **Status**: done
- **Depends on**: T8
- **SDD Phase**: Phase 3 (Frontend — Stash List Section), Section 4
- **Files to modify**:
  - `web-ui/src/stores/workspace-metadata-store.ts` — Add `homeStashCount` to store state; add `useHomeStashCount()` selector hook; update `replaceWorkspaceMetadata` to extract and diff `homeStashCount`
- **Description**: 
  - Add `homeStashCount: number` (defaulting to 0) to the store state.
  - Add `useHomeStashCount(): number` selector hook using `useSyncExternalStore` (follow existing selector pattern in the file).
  - In `replaceWorkspaceMetadata`, extract `homeStashCount` from the incoming `RuntimeWorkspaceMetadata` snapshot and update the store value.
  - This is the single source of truth for stash count in the UI, regardless of home/task context (!4).
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] `useHomeStashCount()` hook exported and returns a number
  - [ ] Store updates when metadata snapshot includes `homeStashCount`
- **Outcome notes**: 
- **Attempts**: 

---

### T13: Create stash list hook (use-stash-list.ts)

- **Grade**: 2
- **Status**: done
- **Depends on**: T5, T12
- **SDD Phase**: Phase 3 (Frontend — Stash List Section), Section 1
- **Files to modify**:
  - `web-ui/src/hooks/use-stash-list.ts` — NEW file
- **Description**: Create `useStashList(taskId: string | undefined, workspaceId: string)` hook:
  - State: `entries: RuntimeStashEntry[]`, `isLoading: boolean`, `isExpanded: boolean`
  - Fetch stash list via `trpcClient.workspace.stashList.query({ taskScope })` on-demand — triggered when `isExpanded` becomes true and when `homeStashCount` (from `useHomeStashCount()`) changes while expanded.
  - Build `taskScope` from `taskId` (same pattern as other hooks using `runtimeTaskWorkspaceInfoRequestSchema`).
  - Expose: `entries`, `isLoading`, `isExpanded`, `setExpanded`, `popStash(index): Promise<void>`, `applyStash(index): Promise<void>`, `dropStash(index): Promise<void>`, `showStashDiff(index): Promise<string>`.
  - Each action calls the corresponding tRPC endpoint, shows toast on success/error via `showAppToast`, triggers refetch of the stash list.
  - `dropStash` does NOT show confirmation dialog (the component handles that).
  - Use `useCallback` for stable function references.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] Hook fetches stash list on expand and on stash count change
  - [ ] All 4 action functions call tRPC and trigger refetch
  - [ ] Actions show toast feedback via `showAppToast`
- **Outcome notes**: 
- **Attempts**: 

---

### T14: Write stash list hook tests (use-stash-list.test.ts)

- **Grade**: 2
- **Status**: done
- **Depends on**: T13
- **SDD Phase**: Phase 3 (Frontend — Stash List Section)
- **Files to modify**:
  - `web-ui/src/hooks/use-stash-list.test.ts` — NEW file. Test cases #1-5 from test spec.
- **Description**: Create `web-ui/src/hooks/use-stash-list.test.ts` following the pattern in `web-ui/src/hooks/use-commit-panel.test.ts`. Mock tRPC client. Implement 5 test cases:
  1. `fetches stash list on mount when expanded` — set expanded, verify tRPC stashList.query called
  2. `refetches when stash count changes` — change mock stash count, verify refetch
  3. `popStash calls tRPC and refetches` — call popStash, verify stashPop.mutate called, then stashList.query re-called
  4. `applyStash calls tRPC and refetches` — same pattern as pop
  5. `dropStash calls tRPC and refetches` — same pattern as pop
- **Acceptance criteria**:
  - [ ] `cd web-ui && npx vitest run src/hooks/use-stash-list.test.ts` — all 5 tests pass
  - [ ] Tests mock tRPC client (not real backend)
- **Outcome notes**: 
- **Attempts**: 

---

### T15: Create stash list section component (stash-list-section.tsx)

- **Grade**: 2
- **Status**: done
- **Depends on**: T13
- **SDD Phase**: Phase 3 (Frontend — Stash List Section), Section 2
- **Files to modify**:
  - `web-ui/src/components/detail-panels/stash-list-section.tsx` — NEW file
- **Description**: Create `StashListSection({ taskId, workspaceId, stashCount })` component:
  - Uses Radix `Collapsible.Root` for expand/collapse (follow pattern at `project-navigation-panel.tsx:394-411`).
  - Header: "Stashes" label with badge showing `stashCount` (prop from metadata store). Chevron icon (ChevronRight from lucide-react, rotated on expand).
  - When expanded: uses `useStashList` hook from T13. Renders entry list or loading spinner.
  - Each entry row: index badge (e.g., `#{index}`), message text (truncated with `truncate` class), originating branch pill, relative date.
  - Right-click context menu per entry (Radix ContextMenu, follow pattern at `commit-panel.tsx:69-142`): Pop, Apply, Drop, Show Diff.
  - Drop action: opens controlled Radix `AlertDialog` confirmation before calling `dropStash(index)`. Use `useRef` flag pattern from AGENTS.md to prevent double-fire on cancel-after-confirm.
  - Show Diff: opens Radix `Popover` anchored to entry row, renders diff in `<pre className="text-xs font-mono whitespace-pre overflow-auto max-h-80 p-3 bg-surface-1 rounded-md">` with `max-width: min(600px, 90vw)`.
  - When `stashCount` is 0, section header still visible but badge hidden or shows 0, and collapsed content shows "No stashes" message.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] Component renders collapsible section with badge count
  - [ ] Entries display index, message, branch, date
  - [ ] Context menu with Pop, Apply, Drop, Show Diff actions — each calls real hook functions (not no-ops)
  - [ ] Drop shows AlertDialog confirmation with useRef guard against double-fire
  - [ ] Diff preview renders in Popover with specified styling
- **Outcome notes**: 
- **Attempts**: 

---

### T16: Wire stash list section into commit panel

- **Grade**: 1
- **Status**: done
- **Depends on**: T15, T12
- **SDD Phase**: Phase 3 (Frontend — Stash List Section), Section 3
- **Files to modify**:
  - `web-ui/src/components/detail-panels/commit-panel.tsx` — Import StashListSection, read stashCount from metadata store, render below file list
- **Description**: 
  - Import `StashListSection` from `./stash-list-section`.
  - Import `useHomeStashCount` from metadata store.
  - Call `const stashCount = useHomeStashCount()` in the component.
  - Render `<StashListSection taskId={taskId} workspaceId={workspaceId} stashCount={stashCount} />` after the existing file list and action buttons, before the discard confirmation dialog (~line 314).
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] Stash list section renders below file list in commit panel
  - [ ] Badge count reflects metadata store value
- **Outcome notes**: 
- **Attempts**: 

---

### T17: Add dirtyTree field to checkout response schema and git-sync

- **Grade**: 1
- **Status**: done
- **Depends on**: T1
- **SDD Phase**: Phase 4 (Frontend — Stash & Retry for Checkout), Section 3
- **Files to modify**:
  - `src/core/api-contract.ts` — Add `dirtyTree: z.boolean().optional()` to `runtimeGitCheckoutResponseSchema` (~line 205)
  - `src/workspace/git-sync.ts` — In `runGitCheckoutAction()` error path (~line 370), detect dirty tree from stderr via regex `/(?:local changes|uncommitted changes|overwritten by checkout)/i` and include `dirtyTree` in failure response
- **Description**: When `runGitCheckoutAction` returns `{ ok: false }`, detect if the failure is due to uncommitted changes by matching stderr against the regex. Set `dirtyTree: true` in the response. This gives the frontend a structured boolean rather than requiring string matching on error messages.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] Checkout failure on dirty tree includes `dirtyTree: true` in response
  - [ ] Non-dirty-tree checkout failures have `dirtyTree` as undefined or false
- **Outcome notes**: 
- **Attempts**: 

---

### T18: Add dirtyTree field to pull response schema and git-sync

- **Grade**: 1
- **Status**: done
- **Depends on**: T1
- **SDD Phase**: Phase 5 (Frontend — Stash & Retry for Pull), Section 2
- **Files to modify**:
  - `src/core/api-contract.ts` — Add `dirtyTree: z.boolean().optional()` to `runtimeGitSyncResponseSchema` (~line 189)
  - `src/workspace/git-sync.ts` — In `runGitSyncAction()` dirty-tree early return (~line 298-306), add `dirtyTree: true` to the response object
- **Description**: In the existing `changedFiles > 0` early return for pull operations, add `dirtyTree: true` to the returned object. Also add the optional field to the Zod schema. This enables the frontend to detect dirty-tree pull failures structurally.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] Pull blocked by dirty tree includes `dirtyTree: true` in response
- **Outcome notes**: 
- **Attempts**: 

---

### T19: Write dirtyTree backend tests

- **Grade**: 2
- **Status**: pending
- **Depends on**: T17, T18
- **SDD Phase**: Phases 4-5 (Backend tests from test spec)
- **Files to modify**:
  - `test/runtime/git-stash.test.ts` — Extend with test cases #17 and #18 from test spec
- **Description**: Add two test cases to the git-stash test file:
  - Test #17: `runGitCheckoutAction returns dirtyTree: true on dirty working tree` — Setup: temp repo, commit file, create branch "other", switch to main, modify tracked file. Action: `runGitCheckoutAction({ cwd, branch: "other" })`. Assert: `{ ok: false, dirtyTree: true }`.
  - Test #18: `runGitSyncAction pull returns dirtyTree: true on dirty working tree` — Setup: temp repo with remote, modify tracked file. Action: `runGitSyncAction({ cwd, action: "pull" })`. Assert: `{ ok: false, dirtyTree: true }`.
- **Acceptance criteria**:
  - [ ] `npx vitest run test/runtime/git-stash.test.ts` — tests #17 and #18 pass
  - [ ] Tests use real git repos
- **Outcome notes**: 
- **Attempts**: 

---

### T20: Add "Stash & Switch" button to checkout confirmation dialog

- **Grade**: 2
- **Status**: done
- **Depends on**: T5
- **SDD Phase**: Phase 4 (Frontend — Stash & Retry for Checkout), Section 1
- **Files to modify**:
  - `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx` — Add `onStashAndCheckout` and `isStashingAndCheckingOut` props; add "Stash & Switch" button to `dirty_warning` variant
- **Description**: 
  - Add two optional props: `onStashAndCheckout?: () => void` and `isStashingAndCheckingOut?: boolean`.
  - In the `dirty_warning` block (~line 101-139), add a third button "Stash & Switch" between Cancel and "Proceed anyway".
  - Style with `variant="primary"` (blue accent) to distinguish from the orange "Proceed anyway".
  - Show spinner when `isStashingAndCheckingOut` is true. Disable all buttons during the operation.
  - Button onClick calls `onStashAndCheckout`.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] "Stash & Switch" button appears in dirty_warning dialog variant
  - [ ] Button calls `onStashAndCheckout` (not a no-op)
  - [ ] Loading state shown during stash-and-checkout operation
- **Outcome notes**: 
- **Attempts**: 

---

### T21: Add stashAndCheckout to branch actions hook

- **Grade**: 2
- **Status**: done
- **Depends on**: T20
- **SDD Phase**: Phase 4 (Frontend — Stash & Retry for Checkout), Section 2
- **Files to modify**:
  - `web-ui/src/hooks/use-branch-actions.ts` — Add `stashAndCheckout` function, wire `onStashAndCheckout` callback to checkout dialog
- **Description**: 
  - Add `stashAndCheckout(branch, scope, checkoutTaskId?, checkoutBaseRef?)` function: builds `taskScope` from hook's `options.taskId` and `options.baseRef` — `const taskScope = options.taskId && options.baseRef ? { taskId: options.taskId, baseRef: options.baseRef } : null`. Calls `trpcClient.workspace.stashPush.mutate({ taskScope, paths: [] })` (stash all), then on success calls `performCheckout(branch, scope, checkoutTaskId, checkoutBaseRef)`.
  - Add `isStashingAndCheckingOut` loading state.
  - Handle errors: if stash fails, show error toast and stay on dialog. If checkout fails after stash, show error toast (stash remains on stack).
  - Pass `onStashAndCheckout` and `isStashingAndCheckingOut` to the checkout dialog props.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] `stashAndCheckout` calls stashPush then performCheckout
  - [ ] Error in stash phase prevents checkout attempt
  - [ ] Props passed to checkout dialog
- **Outcome notes**: 
- **Attempts**: 

---

### T22: Wire stashAndCheckout into checkout confirmation dialog rendering

- **Grade**: 1
- **Status**: done
- **Depends on**: T21
- **SDD Phase**: Phase 4 (Frontend — Stash & Retry for Checkout), Section 2
- **Files to modify**:
  - `web-ui/src/hooks/use-branch-actions.ts` (or parent component that renders `CheckoutConfirmationDialog`) — Pass `onStashAndCheckout` and `isStashingAndCheckingOut` props where the dialog is rendered
- **Description**: Ensure the checkout confirmation dialog receives the `onStashAndCheckout` and `isStashingAndCheckingOut` props from the branch actions hook in whichever parent component renders the dialog. This may already be done in T21 if the hook directly controls the dialog rendering — verify and complete the wiring if not.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] Clicking "Stash & Switch" in the dirty_warning dialog triggers the stash-then-checkout flow end-to-end
- **Outcome notes**: 
- **Attempts**: 

---

### T23: Add stash & retry toast to switchHomeBranch failure

- **Grade**: 2
- **Status**: done
- **Depends on**: T9, T17
- **SDD Phase**: Phase 4 (Frontend — Stash & Retry for Checkout), Section 4
- **Files to modify**:
  - `web-ui/src/hooks/use-git-actions.ts` — Modify `switchHomeBranch` (~line 384-433) to detect `dirtyTree` in response and show toast with "Stash & Switch" action
- **Description**: 
  - In `switchHomeBranch`, on checkout failure, check `payload.dirtyTree` (the structured boolean from T17) instead of matching error strings.
  - When `dirtyTree` is true: show toast via `showAppToast` with `action: { label: "Stash & Switch", onClick: async () => { ... } }`.
  - The action callback: call `trpcClient.workspace.stashPush.mutate({ taskScope: null, paths: [] })`, then retry the checkout by calling `switchHomeBranch` again (or the equivalent checkout mutation directly).
  - Handle stash failure in the action callback with an error toast.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] `switchHomeBranch` failure with dirty tree shows toast with "Stash & Switch" action button
  - [ ] Toast action performs stash then retries checkout
  - [ ] Non-dirty-tree failures show regular error toast (no stash button)
- **Outcome notes**: 
- **Attempts**: 

---

### T24: Add stash & retry props to git action error dialog

- **Grade**: 1
- **Status**: done
- **Depends on**: T5
- **SDD Phase**: Phase 5 (Frontend — Stash & Retry for Pull), Section 1
- **Files to modify**:
  - `web-ui/src/components/git-action-error-dialog.tsx` — Add `onStashAndRetry` and `isStashAndRetrying` optional props; render "Stash & Pull" button when provided
- **Description**: 
  - Add props: `onStashAndRetry?: () => void` and `isStashAndRetrying?: boolean`.
  - When `onStashAndRetry` is provided, render a "Stash & Pull" button alongside "Close": `<Button variant="primary" size="sm" disabled={isStashAndRetrying} onClick={onStashAndRetry}>{isStashAndRetrying ? <Spinner size={14} /> : "Stash & Pull"}</Button>`.
  - When `onStashAndRetry` is not provided, dialog renders as before (only "Close").
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] "Stash & Pull" button appears when `onStashAndRetry` prop is provided
  - [ ] Button calls `onStashAndRetry` (not a no-op)
  - [ ] Spinner shown when `isStashAndRetrying` is true
  - [ ] Dialog unchanged when prop not provided
- **Outcome notes**: 
- **Attempts**: 

---

### T25: Detect dirtyTree pull failure in use-git-actions hook

- **Grade**: 1
- **Status**: done
- **Depends on**: T18, T24
- **SDD Phase**: Phase 5 (Frontend — Stash & Retry for Pull), Section 3
- **Files to modify**:
  - `web-ui/src/hooks/use-git-actions.ts` — In `runGitAction` error handling (~line 356-366), detect `gitActionError.dirtyTree` and conditionally pass `onStashAndRetry` to the error dialog
- **Description**: 
  - When a pull git action fails, check `gitActionError.dirtyTree` (the structured boolean from the response).
  - If `dirtyTree === true`, set state so that the `GitActionErrorDialog` receives `onStashAndRetry` and `isStashAndRetryingPull` props.
  - Add `isStashAndRetryingPull` state variable.
  - If `dirtyTree` is not true, don't pass `onStashAndRetry` (dialog shows only "Close").
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] Dirty-tree pull failure sets `onStashAndRetry` for the error dialog
  - [ ] Non-dirty-tree pull failures do not set `onStashAndRetry`
- **Outcome notes**: 
- **Attempts**: 

---

### T26: Implement stashAndRetryPull function

- **Grade**: 2
- **Status**: done
- **Depends on**: T25
- **SDD Phase**: Phase 5 (Frontend — Stash & Retry for Pull), Section 3
- **Files to modify**:
  - `web-ui/src/hooks/use-git-actions.ts` — Add `stashAndRetryPull` function
- **Description**: Implement `stashAndRetryPull()` function in the hook:
  1. Set `isStashAndRetryingPull = true`
  2. Call `trpcClient.workspace.stashPush.mutate({ taskScope: null, paths: [] })` — stash all changes
  3. If stash fails: show error toast, set loading false, return
  4. Retry the pull via the existing pull mechanism
  5. On pull success: auto-pop stash via `trpcClient.workspace.stashPop.mutate({ taskScope: null, index: 0 })`
  6. On pop result: if `conflicted`, show toast "Pull succeeded. Stash applied with conflicts — resolve them to complete." (conflict panel activates via metadata polling). If pop succeeds, show success toast.
  7. On pull failure after stash: show error toast noting stash remains on stack for manual recovery
  8. Set `isStashAndRetryingPull = false`
  9. Close the error dialog on completion
  
  Wire this function as the `onStashAndRetry` callback passed to the error dialog.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] Stash failure prevents pull attempt
  - [ ] Pull success triggers auto-pop of stash@{0}
  - [ ] Pop conflict shows informative toast message
  - [ ] Pull failure after stash informs user stash is retained
  - [ ] Error dialog closes after operation completes
- **Outcome notes**: 
- **Attempts**: 

---

### T27: Wire stash & pull props into App.tsx

- **Grade**: 1
- **Status**: done
- **Depends on**: T26
- **SDD Phase**: Phase 5 (Frontend — Stash & Retry for Pull), Section 4
- **Files to modify**:
  - `web-ui/src/App.tsx` — Pass `onStashAndRetry` and `isStashAndRetrying` props to `GitActionErrorDialog` (~line 1801-1807)
- **Description**: Where `GitActionErrorDialog` is rendered in App.tsx, pass the `onStashAndRetry` and `isStashAndRetrying` props from the `useGitActions` hook return value. The hook already exposes these after T25/T26 — this task just wires them to the rendered component.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run build` succeeds
  - [ ] `GitActionErrorDialog` receives stash & retry props from the hook
  - [ ] "Stash & Pull" button appears in error dialog for dirty-tree pull failures
- **Outcome notes**: 
- **Attempts**: 

---

### T28: Write edge case and error scenario tests

- **Grade**: 2
- **Status**: done
- **Depends on**: T3
- **SDD Phase**: Cross-phase (Edge cases from test spec)
- **Files to modify**:
  - `test/runtime/git-stash.test.ts` — Extend with edge case tests from test spec
- **Description**: Add edge case tests to the existing git-stash test file:
  1. `stashPush with empty paths array stashes all` — verify `paths: []` equivalent to stash all
  2. `stashPop on empty stack returns error` — no stashes exist, pop returns `{ ok: false, error: ... }`
  3. `stashDrop with stale index returns error` — drop invalid index
  4. `stashPush partial with untracked files` — selected paths include untracked file, verify it's stashed
  5. `stashList on repo with no commits` — brand new repo, returns empty or graceful error
  These may partially overlap with T3 test cases. If so, only add the ones not already covered.
- **Acceptance criteria**:
  - [ ] `npx vitest run test/runtime/git-stash.test.ts` — all tests pass including edge cases
  - [ ] Each edge case scenario is explicitly tested
- **Outcome notes**: 
- **Attempts**: 

---

### T29: Verify regression: existing commit/discard/metadata tests pass

- **Grade**: 1
- **Status**: done
- **Depends on**: T2, T8
- **SDD Phase**: Cross-phase (Regression from test spec)
- **Files to modify**: None (verification only)
- **Description**: Run the full test suite to verify no regressions from stash additions. Specifically check:
  1. Existing `git-commit.test.ts` tests pass
  2. Existing `workspace-api-conflict.test.ts` tests pass
  3. Existing metadata polling tests pass
  4. `npm test` passes (all runtime tests)
  5. `npm run web:test` passes (all web UI tests)
  If any test fails due to the new `homeStashCount` field in `runtimeWorkspaceMetadataSchema`, update the test fixtures to include the field with a default value of 0.
- **Acceptance criteria**:
  - [ ] `npm test` — all existing tests pass
  - [ ] `npm run web:test` — all existing tests pass
  - [ ] No test fixture modifications needed beyond adding `homeStashCount: 0` where `RuntimeWorkspaceMetadata` is constructed
- **Outcome notes**: 
- **Attempts**: 

---

### T30: Full integration smoke test

- **Grade**: 1
- **Status**: done
- **Depends on**: T1-T29
- **SDD Phase**: All phases
- **Files to modify**: None (verification only)
- **Description**: Run the complete build and verification pipeline:
  1. `npm run build` — full production build succeeds
  2. `npm run check` — Biome lint + typecheck + tests all pass
  3. `npm run web:test` — web UI tests pass
  4. Verify all 16 functional verification scenarios from the SDD work (manual, against running dev server)
- **Acceptance criteria**:
  - [ ] `npm run build` succeeds
  - [ ] `npm run check` passes
  - [ ] `npm run web:test` passes
  - [ ] (Manual) Stash button works with selected/all files
  - [ ] (Manual) Stash list shows entries with pop/apply/drop/preview
  - [ ] (Manual) Stash & Switch works in checkout dialog and toast
  - [ ] (Manual) Stash & Pull works in error dialog with auto-pop
  - [ ] (Manual) Drop confirmation dialog works
  - [ ] (Manual) Conflict on pop activates conflict resolution panel
- **Outcome notes**: 
- **Attempts**: 

---

## Plan Corrections Log

[empty for now]

## Summary

[empty for now]
