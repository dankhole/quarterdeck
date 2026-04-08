# Create Task Dialog Shortcut Remap — Implementation Plan

## Overview

Remap keyboard shortcuts in the create task dialog to prioritize the most common action (start task) with the simplest shortcut. Currently `Cmd+Enter` creates without starting, which is the least-used action. This inverts the shortcut hierarchy so the primary workflow gets the easiest key combo.

GitHub issue: #7

## Current State

All shortcuts and UI live in `web-ui/src/components/task-create-dialog.tsx`.

**Current shortcut mapping (single mode):**

| Shortcut | Action | Code location |
|----------|--------|---------------|
| `Cmd+Enter` | Create only (no start) | `task-create-dialog.tsx:343-358` |
| `Cmd+Shift+Enter` | Start task (create + start) | `task-create-dialog.tsx:354-356` |
| `Alt+Shift+Enter` | Start and open (create + start + select) | `task-create-dialog.tsx:378-392` |

**Current shortcut mapping (multi mode):**

| Shortcut | Action |
|----------|--------|
| `Cmd+Enter` | Create all tasks |
| `Cmd+Shift+Enter` | Create and start all tasks |

**Default action persistence:** Stored in localStorage under key `quarterdeck.task-create-primary-start-action` (line 166-170). Values: `"start"` or `"start_and_open"`. Default: `"start"`. Persists across browser refresh and restart. Updated whenever user picks an action from the split-button dropdown (line 282).

**ButtonShortcut component** (lines 58-80): Renders shortcut hint icons. Takes `modifier` (`"mod"` or `"alt"`) and `includeShift` boolean. Renders `⌘` or `⌥` + optional `⇧` + `↵`.

**Shortcut modifier derivation** (lines 398-400):
```typescript
const primaryStartShortcutModifier = effectivePrimaryStartAction === "start" ? "mod" : "alt";
const secondaryStartShortcutModifier = secondaryStartAction === "start" ? "mod" : "alt";
```

## Desired End State

**New shortcut mapping (single mode):**

| Shortcut | Action | Rationale |
|----------|--------|-----------|
| `Cmd+Enter` | Start task | Most common action gets simplest shortcut |
| `Cmd+Shift+Enter` | Start and open | Second most common, one modifier added |
| `Cmd+Alt+Enter` | Create only | Least common, requires explicit intent |

**New shortcut mapping (multi mode):**

| Shortcut | Action |
|----------|--------|
| `Cmd+Enter` | Create and start all tasks |
| `Cmd+Alt+Enter` | Create all tasks (no start) |

**Split-button dropdown:** No changes to the dropdown mechanism itself. The stored primary action still controls which start variant is the primary button. Only the shortcut hints on buttons and dropdown items change.

## Out of Scope

- Redesigning the split-button/dropdown (works fine as-is)
- Changing the inline create card (`task-inline-create-card.tsx`) shortcuts
- Changing the global `c` hotkey to open the dialog
- Modifying how the default action is persisted in localStorage
- Backend/runtime changes (this is purely frontend)

## Dependencies

None — this is a self-contained frontend change in a single file.

## Implementation Approach

Single phase. All changes are in `task-create-dialog.tsx` and are tightly coupled — the hotkey bindings, button shortcut hints, and modifier derivation logic must stay in sync.

## Phase 1: Remap Shortcuts and Update UI Hints

### Overview

Remap all `useHotkeys` bindings and update every `ButtonShortcut` usage and shortcut hint to reflect the new key combos.

### Changes Required

#### 1. Remap `useHotkeys` bindings

**File**: `web-ui/src/components/task-create-dialog.tsx`

**Change the first `useHotkeys` block (lines 342-375):**

Currently handles `mod+enter` and `mod+shift+enter`. Needs to handle `mod+enter`, `mod+shift+enter`, and `mod+alt+enter` with new action mapping:

```typescript
// Cmd/Ctrl+Enter → Start task (single) or Start all (multi)
// Cmd/Ctrl+Shift+Enter → Start and open (single only, falls through to start all in multi)
// Cmd/Ctrl+Alt+Enter → Create only (single) or Create all (multi)
useHotkeys(
   "mod+enter, mod+shift+enter, mod+alt+enter",
   (event) => {
      if (mode === "multi") {
         if (event.altKey) {
            handleCreateAll();
            return;
         }
         handleCreateAndStartAll();
         return;
      }
      if (event.altKey) {
         handleCreateSingle();
         return;
      }
      if (event.shiftKey) {
         handleRunSingleStartAction("start_and_open");
         return;
      }
      handleRunSingleStartAction("start");
   },
   { /* same options as current */ },
   [open, mode, handleCreateAll, handleCreateAndStartAll, handleCreateSingle, handleRunSingleStartAction],
);
```

**Remove the second `useHotkeys` block (lines 377-392):** The `alt+shift+enter` binding is no longer needed — `mod+shift+enter` now handles "start and open". This block is fully replaced by the expanded first block above.

#### 2. Update shortcut modifier derivation

**File**: `web-ui/src/components/task-create-dialog.tsx` (lines 396-400)

The primary/secondary start shortcuts are no longer driven by whether the action is "start" vs "start_and_open". They're now fixed:

- "Start task" always shows `⌘↵` (mod, no shift)
- "Start and open" always shows `⌘⇧↵` (mod, with shift)

Replace:
```typescript
const primaryStartShortcutModifier = effectivePrimaryStartAction === "start" ? "mod" : "alt";
const secondaryStartShortcutModifier = secondaryStartAction === "start" ? "mod" : "alt";
```

With:
```typescript
const primaryStartIncludesShift = effectivePrimaryStartAction === "start_and_open";
const secondaryStartIncludesShift = secondaryStartAction === "start_and_open";
```

#### 3. Update ButtonShortcut props on buttons

**File**: `web-ui/src/components/task-create-dialog.tsx`

**"Create" button (line 611):** Currently `<ButtonShortcut />` (shows `⌘↵`). Change to show `⌘⌥↵`:
```tsx
<ButtonShortcut modifier="alt" />
```

**Primary start button (line 626):** Currently `<ButtonShortcut includeShift modifier={primaryStartShortcutModifier} />`. Change to:
```tsx
<ButtonShortcut includeShift={primaryStartIncludesShift} />
```
(No modifier prop needed — defaults to `"mod"`, which is correct for both start variants.)

**Multi-mode "Create N tasks" button (line 680):** Currently `<ButtonShortcut />` (shows `⌘↵`). Change to show `⌘⌥↵`:
```tsx
<ButtonShortcut modifier="alt" />
```

**Multi-mode "Start N tasks" button (line 692):** Currently `<ButtonShortcut includeShift />` (shows `⌘⇧↵`). Change to just `⌘↵`:
```tsx
<ButtonShortcut />
```

#### 4. Update dropdown secondary action hint

**File**: `web-ui/src/components/task-create-dialog.tsx` (lines 656-668)

The dropdown shows the secondary start action's shortcut. Currently uses `secondaryStartShortcutModifier` to decide between `⌥` and `⌘`. Now both variants use `⌘`, differing only in whether `⇧` is shown.

Replace the modifier icon logic with: always show `⌘`, conditionally show `⇧` based on `secondaryStartIncludesShift`:

```tsx
<span className="inline-flex items-center gap-0.5 text-text-tertiary" aria-hidden>
   <Command size={10} />
   {secondaryStartIncludesShift ? <ArrowBigUp size={10} /> : null}
   <CornerDownLeft size={10} />
</span>
```

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run web:typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Web UI tests pass: `npm run web:test`

#### Manual

- [ ] Open create task dialog, press `Cmd+Enter` → task is created AND started
- [ ] Open create task dialog, press `Cmd+Shift+Enter` → task is created, started, and opened
- [ ] Open create task dialog, press `Cmd+Alt+Enter` → task is created only (stays in backlog)
- [ ] "Create" button shows `⌘⌥↵` shortcut hint
- [ ] Primary start button shows `⌘↵` (when default is "Start task") or `⌘⇧↵` (when default is "Start and open")
- [ ] Dropdown secondary action shows correct shortcut hint (inverse of primary)
- [ ] In multi mode: `Cmd+Enter` starts all, `Cmd+Alt+Enter` creates all
- [ ] Multi-mode button hints match the new shortcuts
- [ ] Selecting a dropdown action still persists the preference in localStorage

## Risks

- **Browser/OS shortcut conflict**: `Cmd+Alt+Enter` is not a common OS shortcut on macOS, so conflict is unlikely. On Windows, `Ctrl+Alt+Enter` is also uncommon. Low risk.
- **Muscle memory**: Users accustomed to the old shortcuts will need to adjust. The button hints provide discoverability. Low risk for a personal tool.

## References

- GitHub issue: #7
- Primary file: `web-ui/src/components/task-create-dialog.tsx`
- ButtonShortcut component: `task-create-dialog.tsx:58-80`
- useHotkeys bindings: `task-create-dialog.tsx:342-392`
- Shortcut modifier logic: `task-create-dialog.tsx:396-400`
- Split-button UI: `task-create-dialog.tsx:615-672`
- localStorage persistence: `task-create-dialog.tsx:166-170`
