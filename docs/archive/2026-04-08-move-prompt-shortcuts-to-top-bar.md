# Move Prompt Shortcut Button from Task Cards to TopBar

## Context

The prompt shortcut split button (agent prompt injection) is currently rendered on **every** review-column BoardCard — identical UI, identical state, differing only by `card.id`. This requires 6 props threaded through 4 intermediate pass-through layers (App → CardDetailView → ColumnContextPanel → ColumnSection → BoardCard). Moving it to a single TopBar instance eliminates the redundancy and simplifies the card component. Long-term destination is a bottom shortcut bar; top bar is the interim home.

## Plan

### 1. Add prompt shortcut split button to TopBar

**File**: `web-ui/src/components/top-bar.tsx`

- Add `MessageSquare` to lucide-react imports
- Import `PromptShortcut` type from `@/runtime/types`
- Add 6 new props: `promptShortcuts`, `selectedPromptShortcutLabel`, `onSelectPromptShortcutLabel`, `isPromptShortcutRunning`, `onRunPromptShortcut`, `onManagePromptShortcuts`
- Derive `activePromptShortcut` from the array + selected label (same pattern as project shortcuts)
- Render split button after the project shortcut block (line ~566), inside the right-side actions div
  - Condition: `!hideProjectDependentActions && selectedTaskId && activePromptShortcut`
  - Use `variant="default"` + `kb-navbar-btn` for navbar consistency
  - `MessageSquare` icon to distinguish from project shortcuts' configurable icons
  - RadixPopover dropdown (matching project shortcut pattern), with "Manage shortcuts..." footer item
  - Left button calls `onRunPromptShortcut(selectedTaskId, activePromptShortcut.label)`

### 2. Wire props from App.tsx to TopBar

**File**: `web-ui/src/App.tsx`

- Add 6 prompt shortcut props to the `<TopBar>` JSX (lines 895-948):
  - `promptShortcuts={runtimeProjectConfig?.promptShortcuts ?? []}`
  - `selectedPromptShortcutLabel={lastUsedPromptShortcutLabel}`
  - `onSelectPromptShortcutLabel={selectPromptShortcutLabel}`
  - `isPromptShortcutRunning={isPromptShortcutRunning}`
  - `onRunPromptShortcut={runPromptShortcut}`
  - `onManagePromptShortcuts={() => setPromptShortcutEditorOpen(true)}`
- Remove the same 6 props from the `<CardDetailView>` JSX (lines 1128-1133)

### 3. Remove prompt shortcut props from CardDetailView

**File**: `web-ui/src/components/card-detail-view.tsx`

- Remove 6 props from function signature (lines 270-275) and type (lines 322-327)
- Remove 6 props from `<ColumnContextPanel>` usage (lines 683-688)

### 4. Remove prompt shortcut props from ColumnContextPanel

**File**: `web-ui/src/components/detail-panels/column-context-panel.tsx`

- Remove from outer component props (lines 273-278, 303-308)
- Remove conditional forwarding to `<ColumnSection>` (lines 403-408)
- Remove from ColumnSection props (lines 36-41, 67-72)
- Remove from `<BoardCard>` usage within ColumnSection (lines 217-222)

### 5. Remove prompt shortcut UI and props from BoardCard

**File**: `web-ui/src/components/board-card.tsx`

- Remove 6 props from signature (lines 186-191) and type (lines 217-222)
- Delete the entire IIFE block rendering the split button (lines 627-701)
- Remove now-unused imports: `DropdownMenu` from `@radix-ui/react-dropdown-menu`, `Check`, `ChevronDown`, `Settings` from lucide-react (verify each has no other usage first)

### 6. Update tests

**File**: `web-ui/src/components/board-card.test.tsx`
- Remove prompt shortcut test (lines 371-391)

**File**: `web-ui/src/components/top-bar.test.tsx`
- Add tests: shows button when task selected + shortcuts configured, hides when no task selected, hides when shortcuts empty, calls `onRunPromptShortcut` with correct taskId + label

### 7. Update planned-features.md

**File**: `docs/planned-features.md`
- Mark #27 as implemented with commit reference

## Architectural Validation

### Confirmed safe

- **No session guard needed in TopBar**: `sendTaskSessionInput` → server-side `terminalManager.writeInput()` returns `{ ok: false, error: "Task session is not running." }` for non-running sessions → `runPromptShortcut` shows a toast. No crash, graceful degradation. We don't need to pass columnId or session state to TopBar.
  - Evidence: `use-task-sessions.ts:197-234` (client), `runtime-api.ts:225-250` (server)
- **Single hook call site**: `usePromptShortcuts` is called only in `App.tsx:525-536`. No restructuring needed — just wire the existing return values to TopBar.
- **No hidden consumers**: Only `BoardCard` renders prompt shortcut UI. The removal chain (CardDetailView → ColumnContextPanel → ColumnSection → BoardCard) is complete — no orphaned references.
- **Layout safe**: TopBar right side is `shrink-0`, left side has `flex-1 min-w-0 overflow-hidden` with truncating workspace path (`max-w-[640px]`, `truncate` class) and git branch. Adding a second split button compresses the left side gracefully. No responsive breakpoints exist, but none are needed for this addition.

### Guard condition

- **`hideProjectDependentActions`**: Must gate prompt shortcuts (same as project shortcuts) — prompt shortcuts are project-scoped config. Condition: `!hideProjectDependentActions && selectedTaskId && activePromptShortcut`.
  - `hideProjectDependentActions` is true when no card selected AND workspace is in transitional state (`App.tsx:819-820`)
- **`selectedCard` can be any column**: `findCardSelection` searches all columns including backlog and trash (`board-state.ts:643-655`). This is fine — the old review-only restriction was a card-clutter concern. If user sends a prompt to a non-running session, they get a clear toast error.

## Design Decisions

- **Visibility**: Show when any task is selected (not review-only) — sending prompts works for in_progress and review tasks alike. The review-only restriction was a card clutter concern, not functional. Server-side validation handles the edge case gracefully.
- **Styling**: `variant="default"` + `kb-navbar-btn` to match project shortcuts. `MessageSquare` icon distinguishes "send prompt to agent" from "run shell command".
- **Dropdown**: RadixPopover (matching existing TopBar pattern) instead of DropdownMenu (which the card used).
- **Guard**: `!hideProjectDependentActions && selectedTaskId && activePromptShortcut` — gates on project readiness, task selection, and having shortcuts configured.

## Verification

1. `npm run web:typecheck` — no type errors
2. `npm run lint` — clean
3. `npm run test:fast && npm run web:test` — all pass
4. Manual: select a task → prompt shortcut button appears in top bar, fires prompt to agent terminal. Deselect → button disappears. Review cards no longer show the button.
5. Manual edge case: select a backlog card (no session) → button appears → click it → toast says "Task session is not running." — confirms graceful degradation.
