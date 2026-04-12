# Compare tab: include uncommitted changes + fix staleness

## Context

The compare tab currently shows only committed diffs between two refs (`git diff fromRef toRef`). It fetches once and never updates — the comment at `git-view.tsx:357` says "No polling for compare — branch diffs are stable" but this isn't true when an agent is actively working. Two issues to fix together:

1. **Include uncommitted changes** with a clearly labeled checkbox (default ON)
2. **Fix staleness (TODO #11)** so the diff stays current as the agent commits

## Approach

### Staleness fix (both modes)

`useRuntimeWorkspaceChanges` already supports a `stateVersion` param that triggers a refetch when it changes. The compare tab currently passes `0` (never refetch). Changing this to `taskWorkspaceStateVersion` makes committed diffs update reactively whenever the agent commits — no polling needed for ref-to-ref diffs.

### Uncommitted changes

The backend already has `getWorkspaceChangesFromRef({cwd, fromRef})` which diffs `fromRef` against the working tree (committed + uncommitted + untracked). When the checkbox is checked, we send only `fromRef` (omit `toRef`); the backend routes to this function. When unchecked, we send both refs and keep the current `getWorkspaceChangesBetweenRefs` path.

Polling (1s, same as uncommitted/last-turn tabs) is only enabled when the checkbox is ON, since working tree state can change at any time without a version bump. When OFF, the reactive `stateVersion` alone is sufficient.

### UX: "Include uncommitted work" checkbox

The checkbox lives in the CompareBar, right-aligned, always visible:
```
[Source ▼] [→] [Target ▼] [↙ Reset]  ................  [✓] Include uncommitted work
```
This makes it immediately clear whether you're looking at committed-only diffs or the full working tree state. The label "Include uncommitted work" is unambiguous — it means staged + unstaged + untracked changes on top of the committed diff.

## Refresh behavior summary

| Checkbox | stateVersion | polling | What triggers refetch |
|----------|-------------|---------|----------------------|
| OFF (refs only) | `taskWorkspaceStateVersion` | none | Agent commits |
| ON (working tree) | `taskWorkspaceStateVersion` | 1s (active + visible) | Agent commits OR working tree changes |

## Files to change

### 1. `web-ui/src/storage/local-storage-store.ts`
Add new key to `LocalStorageKey` enum:
```
CompareIncludeUncommitted = "quarterdeck.compare-include-uncommitted"
```

### 2. `web-ui/src/hooks/use-git-view-compare.ts`
- Add `includeUncommitted: boolean` and `setIncludeUncommitted: (v: boolean) => void` to `UseGitViewCompareResult`
- Add `useState` initialized from localStorage (default `true` — only stored `"false"` turns it off)
- Setter persists to localStorage
- Return both in the hook result

### 3. `web-ui/src/components/git-view.tsx`

**CompareBar** (line 130-199):
- Add `includeUncommitted` + `onIncludeUncommittedChange` props
- Add a Radix Checkbox (label: "Include uncommitted work") right-aligned with `ml-auto`
- Use the standard checkbox pattern: `@radix-ui/react-checkbox` with `data-[state=checked]:` styling

**Compare data fetching** (lines 350-362):
- Change `stateVersion` from `0` to `taskWorkspaceStateVersion` (fixes staleness for both modes)
- Change `pollIntervalMs`: only poll when checkbox is ON — `isCompareActive && includeUncommitted && isDocumentVisible ? POLL_INTERVAL_MS : null`
- Add `":wt"` / `":refs"` suffix to `viewKey` so toggling invalidates cache
- When checkbox is ON: pass `toRef` as `undefined` (omit it)
- When checkbox is OFF: pass `compare.sourceRef` as `toRef` (current behavior)

**CompareBar invocation** (lines 474-486):
- Pass `includeUncommitted={compare.includeUncommitted}` and `onIncludeUncommittedChange={compare.setIncludeUncommitted}`

### 4. `src/trpc/workspace-api.ts` (line 659)
Insert new path between Path A and Path B:
```typescript
// Path A2: Ref-to-working-tree (Compare with uncommitted)
if (input.fromRef && !input.toRef) {
    validateRef(input.fromRef, "fromRef");
    // same cwd resolution as Path A...
    return await getWorkspaceChangesFromRef({ cwd, fromRef: input.fromRef });
}
```
This reuses the existing `getWorkspaceChangesFromRef` function — no new git logic needed.

### 5. `test/runtime/trpc/workspace-api.test.ts`
Add tests for the new `fromRef`-only path:
- Task-scoped: sends `{ taskId, baseRef, fromRef }` (no toRef) → asserts `getWorkspaceChangesFromRef` called
- Home repo: sends `{ taskId: null, fromRef }` → asserts `getWorkspaceChangesFromRef` called with workspace path
- Missing worktree: asserts `createEmptyWorkspaceChangesResponse` fallback

### 6. `docs/todo.md`
Remove TODO #11 (lines 114-116) and renumber.

### 7. `CHANGELOG.md` + `docs/implementation-log.md`
Add entries per release hygiene rules.

## Verification
1. `npm run typecheck && npm run web:typecheck` — no type errors
2. `npm run test:fast` — existing + new tests pass
3. Manual: open a task's compare tab with checkbox ON → should show committed + uncommitted changes, updating live as the agent works. Toggle checkbox OFF → should show only committed diffs between the two refs, still updating reactively when the agent commits but not polling.
