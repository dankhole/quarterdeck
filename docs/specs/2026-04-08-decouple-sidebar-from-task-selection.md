# Spec: Decouple Sidebar from Task Selection

**Todo item**: #13
**Date**: 2026-04-08
**Status**: Ready

---

## Goal

Make the sidebar (thin icon strip + side panel) always visible, not just when a task is selected. This is the enabling work for making the sidebar the primary navigation surface. The board view, project switcher (#10), git management (#14), and task detail would all be views composed within the same sidebar shell.

## Behavioral Change Statement

> **BEFORE**: The sidebar (`DetailToolbar` + side panels) only exists inside `CardDetailView` (`card-detail-view.tsx`), which requires a `CardSelection` prop. The home view has a completely separate layout with `ProjectNavigationPanel` as a standalone `<aside>` in `App.tsx`. The two layouts are mutually exclusive — the home view is hidden (`visibility: hidden`) behind `CardDetailView` when a task is open.
>
> **AFTER**: The sidebar is always visible with 4 tabs: Home (always enabled), Task Column / Changes / Files (greyed out when no task selected). Selecting a task auto-switches to the last active task-tied tab. Clicking Home deselects the task and shows the board. `ProjectNavigationPanel` moves into the Home tab's side panel. The two separate layout trees merge into one.
>
> **SCOPE**: Every code path listed below must be verified against the new layout:
> - `App.tsx` layout structure (the `!selectedCard` home/detail conditional, the `visibility: hidden` overlay pattern, the `CardDetailView` rendering gate)
> - `CardDetailView` (`card-detail-view.tsx`) — sidebar extraction, becomes main-view-only
> - `DetailToolbar` (`detail-panels/detail-toolbar.tsx`) — gains Home tab + disabled states
> - `ProjectNavigationPanel` (`project-navigation-panel.tsx`) — moves into side panel slot
> - `useCardDetailLayout` (`resize/use-card-detail-layout.ts`) — gains `"home"` + `"task_column"` tab IDs, `lastTaskTab` persistence
> - All 14 `setSelectedTaskId` call sites (see "Task Selection Call Sites" below)
> - Keyboard shortcuts in `use-app-hotkeys.ts` (Cmd+J, Cmd+M, Escape)
> - Terminal slot management: home terminal vs detail terminal
> - `useProjectNavigationLayout` — becomes unused (pixel-based resize replaced by ratio-based)

## Functional Verification Steps

1. **App launch**: Open Quarterdeck → sidebar visible with Home tab active, project list in side panel, board in main view. Home tab button highlighted in sidebar.
2. **Task selection from board**: Click a task card on the board → sidebar switches to Task Column tab (or last remembered task tab), main view shows agent terminal, task highlighted in Task Column. Verify via: task card click triggers `handleCardSelect` (in `use-board-interactions.ts`), which calls `setSelectedTaskId`.
3. **Home tab while task open**: Click Home tab → task deselected (`setSelectedTaskId(null)`), board returns in main view, project nav in side panel. Back button in top bar should also still work identically (`handleBack` in `App.tsx`).
4. **Tab memory**: Open Changes tab → click Home → select a task → Changes tab is active (not Task Column). Verify via: `lastTaskTab` in localStorage persists across tab switches.
5. **Greyed-out tabs**: With no task selected, Task Column/Changes/Files tabs render with reduced opacity and `pointer-events: none`. Clicking them does nothing.
6. **Project switching**: In Home tab side panel, click a different project → board reloads, task deselected, still on Home tab. All state resets in `handleProjectSwitchStart` (in `App.tsx`) fire correctly.
7. **Escape key chain**: With task open and diff expanded → Escape collapses diff. Escape again → deselects task. With no task, Escape on home git history → closes git history. Verify the unified Escape handler (see section 8) covers all cases after the `CardDetailView` and `use-app-hotkeys.ts` handlers are consolidated.
8. **Terminal persistence**: Open home terminal → select a task → click Home → home terminal still running. Open detail terminal → switch between task-tied tabs → detail terminal still running. Verify via: `PersistentTerminal` instances survive mount/unmount (`persistent-terminal-manager.ts` module-level map).
9. **Cmd+J terminal toggle**: No task → toggles home terminal. Task selected → toggles detail terminal. Same behavior as today (via `use-app-hotkeys.ts`).
10. **Cmd+M terminal expand**: No task → expands home terminal. Task selected → expands detail terminal. Same behavior as today (via `use-app-hotkeys.ts`).
11. **Board drag-and-drop**: Drag a card between columns on the board (main view) → works identically. `QuarterdeckBoard` receives the same props.
12. **Create-start-and-open task**: Use `handleCreateStartAndOpenTask` → task created, started, selected, sidebar switches to Task Column tab. (via `use-task-start-actions.ts`)
13. **Trash a selected task**: Move selected task to trash → selection advances to next task or deselects. (via `use-linked-backlog-task-actions.ts` and `use-board-interactions.ts`)
14. **Clear all trash**: Clear trash while selected task is in trash → task deselected. (via `use-board-interactions.ts`)
15. **Edit task inline**: Click edit on a backlog task → task deselected (unless `preserveDetailSelection`), inline editor appears. (via `use-task-editor.ts`)
16. **localStorage migration**: Existing users with `"quarterdeck"` stored in `quarterdeck.detail-active-panel` → loads as `"home"` (not broken, not stuck on a nonexistent panel).

## Current State

Two mutually exclusive layouts exist in `App.tsx`:

- **Home view** (`!selectedCard` branch): `ProjectNavigationPanel` as top-level `<aside>` + board/git-history in `kb-home-layout` div
- **Detail view** (`selectedCard && detailSession` branch): `CardDetailView` as an absolute-positioned overlay containing `DetailToolbar` + side panel + agent terminal

The home view is hidden (`visibility: hidden`) behind `CardDetailView` when a task is open. The sidebar only exists inside `CardDetailView`, which hard-requires `selection: CardSelection`.

### Task Selection Call Sites

All 14 places `setSelectedTaskId` is called — every one must work correctly with the new layout:

| # | Location | Action | New behavior notes |
|---|---|---|---|
| 1 | `App.tsx` `handleProjectSwitchStart` | `null` — project switch | No change needed (useEffect handles tab switch) |
| 2 | `App.tsx` currentProjectId effect | `null` — project loaded | No change needed (useEffect handles tab switch) |
| 3 | `App.tsx` orphaned selection guard | `null` — card removed from board | No change needed (useEffect handles tab switch) |
| 4 | `App.tsx` `handleBack` | `null` — back button | Also closes git history (`setIsGitHistoryOpen(false)`), independent of tab switching. useEffect handles tab switch to Home. |
| 5 | `use-task-editor.ts` `handleOpenEditTask` | `null` — open inline editor | useEffect switches to Home tab (board needs to be visible for inline editor) |
| 6 | `use-board-interactions.ts` `handleDragEnd` | `draggableId` — select dropped card | Only fires `setSelectedTaskId` when `selectDroppedTask: true` (detail task column drag). Board-level drag does not change selection. When it does fire, useEffect switches to last task tab. |
| 7 | `use-board-interactions.ts` `handleCardSelect` | `taskId` — card click | Imperative `setIsGitHistoryOpen(false)` call stays alongside `setSelectedTaskId`. useEffect only handles tab switching. |
| 8 | `use-board-interactions.ts` interrupted task trash | `nextTaskId` — auto-advance | Stay on current task tab (task-to-task, useEffect no-ops) |
| 9 | `use-board-interactions.ts` interrupted task immediate | `nextTaskId` — auto-advance | Stay on current task tab (task-to-task, useEffect no-ops) |
| 10 | `use-board-interactions.ts` `handleConfirmClearTrash` | `null` — clear trash | useEffect switches to Home tab |
| 11 | `use-linked-backlog-task-actions.ts` trash (already in trash) | `nextTaskId` — advance | Stay on current task tab (task-to-task, useEffect no-ops) |
| 12 | `use-linked-backlog-task-actions.ts` trash (normal) | `nextTaskId` — advance | Stay on current task tab (task-to-task, useEffect no-ops) |
| 13 | `use-linked-backlog-task-actions.ts` trash (optimistic) | `nextTaskId` — advance | Stay on current task tab (task-to-task, useEffect no-ops) |
| 14 | `use-task-start-actions.ts` create-start-and-open | `taskId` — select new task | useEffect switches to last task tab |

**Rule**: When `setSelectedTaskId` transitions from `null` → `taskId`, switch to `lastTaskTab`. When it transitions from `taskId` → `null`, switch to `"home"`. When it transitions from `taskId` → `anotherTaskId`, stay on current tab.

## Target State

The sidebar is always rendered with 4 tabs split into two groups:

```
┌──┬────────────────┬──────────────────────────────┐
│  │                │ Top Bar                      │
│🏠│  Side Panel     ├──────────────────────────────┤
│──│                │                              │
│📋│  (varies by    │  Main View                   │
│🔀│   active tab)  │  (board or agent terminal)   │
│📁│                │                              │
│  │                ├──────────────────────────────┤
│  │                │  Terminal (optional, bottom)  │
└──┴────────────────┴──────────────────────────────┘
```

**Sidebar tabs:**

| Position | Tab | ID | Tied to task? | Side panel content | Main view content |
|---|---|---|---|---|---|
| Top group | Home | `home` | No | Project nav (project list, agent section) | Board / Git History |
| Divider | --- | | | | |
| Bottom group | Task Column | `task_column` | Yes | Stacked columns with selected task highlighted | Agent Terminal |
| Bottom group | Changes | `changes` | Yes | Diff viewer + file tree | Agent Terminal |
| Bottom group | Files | `files` | Yes | File browser | Agent Terminal |

### Behavior Rules

1. **App opens to the Home tab** by default.
2. **Task-tied tabs are greyed out (disabled, not clickable) when no task is selected.**
3. **Selecting a task from the board** (via Home tab's main view) auto-switches to the last active task-tied tab. If no task-tied tab was previously active, defaults to Task Column. If the side panel was collapsed (`activeTab = null`), selecting a task opens it with `lastTaskTab`.
4. **Clicking the Home tab while a task is open** deselects the task and returns to the board in the main view.
5. **The last active task-tied tab is remembered** in localStorage. If you were on Changes, go to Home, then select a task, you return to Changes.
6. **Clicking between tasks** (e.g. in the Task Column side panel) stays on the current task-tied tab.
7. **Clicking the already-active tab toggles the side panel closed** (`activeTab = null`). This matches the current `DetailToolbar` behavior where clicking the active panel sets it to `null`. Main view content is unaffected by side panel collapse — it depends on `selectedCard`, not `activeTab`.
8. **Side panel collapse is respected on deselection**: When `activeTab` is `null` (user deliberately collapsed the panel) and the selected task is deselected, the panel stays collapsed. The tab state does not auto-open the panel on deselection.
9. **When `isDiffExpanded` or `isFileBrowserExpanded` is true**, the sidebar toolbar and side panel hide (same as current behavior). The expanded view takes the full width of the main view area. This matches the current UX where expanding a diff gives it maximum screen real estate.

## Detailed Design

### 1. SidebarTabId Type and localStorage

**File**: `resize/use-card-detail-layout.ts` (or renamed to `use-sidebar-layout.ts`)

Replace `DetailPanelId` with:

```typescript
export type TaskTabId = "task_column" | "changes" | "files";
export type SidebarTabId = "home" | TaskTabId;
```

`TaskTabId` is used for `lastTaskTab` (which only stores task-tied tabs). `SidebarTabId` is used for `activeTab` (which can be any tab).

**localStorage migration** in `loadActiveTab`:

```typescript
function loadActiveTab(): SidebarTabId | null {
   const stored = readLocalStorageItem(LocalStorageKey.DetailActivePanel);
   // Map old "quarterdeck" value to "home". This is a deliberate rename —
   // the old "quarterdeck" tab (Task Column side panel) becomes "home" because
   // the Home tab is the new default/landing tab. The old task column content
   // moves to the "task_column" tab, but existing users should land on Home
   // after upgrade, not be stuck on a nonexistent panel.
   if (stored === "quarterdeck" || stored === "home") return "home";
   if (stored === "task_column" || stored === "changes" || stored === "files") return stored;
   if (stored === "") return null; // panel was collapsed
   // Default for new installs
   return "home";
}
```

**New localStorage key** for `lastTaskTab`:

```typescript
// New key in LocalStorageKey enum
DetailLastTaskTab = "quarterdeck.detail-last-task-tab"
```

```typescript
type TaskTabId = "task_column" | "changes" | "files";

function loadLastTaskTab(): TaskTabId {
   const stored = readLocalStorageItem(LocalStorageKey.DetailLastTaskTab);
   // No migration needed — this is a new key that never stored "quarterdeck"
   if (stored === "task_column" || stored === "changes" || stored === "files") return stored;
   return "task_column"; // default
}
```

The existing ratio/width localStorage keys (`quarterdeck.detail-side-panel-ratio`, etc.) are **unaffected** — they store numbers, not panel IDs.

**Unit tests required** for `loadActiveTab` migration logic:
- `"quarterdeck"` stored → returns `"home"`
- `"home"` stored → returns `"home"`
- `"changes"` stored → returns `"changes"`
- `"files"` stored → returns `"files"`
- `""` (empty) stored → returns `null` (collapsed)
- No value stored → returns `"home"` (default)
- Invalid value stored → returns `"home"` (default)

### 2. App.tsx Layout Restructure

Replace the current mutually-exclusive layout pattern with a unified structure:

**State ownership for expanded views**: `isDiffExpanded` and `isFileBrowserExpanded` are **lifted to App.tsx as state** (not owned by `TaskMainView`). App.tsx passes down `onDiffExpandedChange` and `onFileBrowserExpandedChange` callbacks. The ownership chain:
- `App.tsx` owns `isDiffExpanded` / `isFileBrowserExpanded` state
- `App.tsx` passes `isDiffExpanded`, `onDiffExpandedChange` (and likewise for file browser) to `TaskMainView`
- `TaskMainView` passes `onDiffExpandedChange` to the Changes side panel (which hosts the expand button)
- `App.tsx` reads `isDiffExpanded` / `isFileBrowserExpanded` to conditionally hide the sidebar
- The unified Escape handler (section 8) reads and resets these states directly since it lives at the App level

```tsx
// App.tsx — new top-level layout
<div className="flex h-[100svh] min-w-0 overflow-hidden">
   {/* Sidebar + side panel — hidden when diff or file browser is expanded */}
   {!isDiffExpanded && !isFileBrowserExpanded ? (
      <>
         {/* Sidebar — always rendered */}
         <SidebarToolbar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            hasSelectedTask={selectedCard !== null}
            hasUncommittedChanges={...}
         />

         {/* Side panel — renders when activeTab is not null */}
         {activeTab !== null ? (
            <>
               <SidePanelContent activeTab={activeTab} ... />
               <ResizeHandle ... />
            </>
         ) : null}
      </>
   ) : null}

   {/* Main area — Top Bar + Main View + Bottom Terminal */}
   <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
      <TopBar ... />
      <div className="flex flex-1 min-h-0 overflow-hidden">
         {selectedCard ? (
            {/* Agent terminal + expanded diff/file browser */}
            <TaskMainView
               sessionSummary={detailSession}
               ...
            />
         ) : (
            {/* Board or Git History */}
            <HomeMainView ... />
         )}
      </div>
   </div>
</div>
```

**Key**: The `visibility: hidden` overlay pattern is **removed**. The board unmounts when a task is selected. This is acceptable — board scroll position is not critical.

### 3. SidebarToolbar Changes

**File**: `components/detail-panels/detail-toolbar.tsx`

Add Home button above existing 3, with a visual separator:

```
[Home icon]       ← always enabled
─── divider ───   ← 1px line, ~8px vertical margin
[Task Column]     ← greyed out when !hasSelectedTask
[Changes]         ← greyed out when !hasSelectedTask
[Files]           ← greyed out when !hasSelectedTask
```

Props change:

```typescript
interface SidebarToolbarProps {
   activeTab: SidebarTabId | null;
   onTabChange: (tab: SidebarTabId) => void;
   hasSelectedTask: boolean;
   hasUncommittedChanges?: boolean;
}
```

Disabled (task-tied, no task) tabs use Tailwind utility classes:
- `opacity-35` (reduced visibility)
- `pointer-events-none` (not clickable)
- `cursor-default` (no pointer cursor)

Applied conditionally via `cn()` when `!hasSelectedTask`.

Home icon: `House` from lucide-react (size 18, matching existing icons).

### 4. Tab Switching Logic

New hook (or extension of `useCardDetailLayout`):

```typescript
function handleTabChange(tab: SidebarTabId): void {
   if (tab === activeTab) {
      // Toggle side panel closed (same behavior as current DetailToolbar)
      setActiveTab(null);
      return;
   }
   if (tab === "home") {
      // Deselect task if one is selected
      if (selectedCard) {
         setSelectedTaskId(null);
      }
      setActiveTab("home");
      return;
   }
   // Task-tied tab — only reachable when hasSelectedTask is true
   setActiveTab(tab);
   setLastTaskTab(tab); // persist to localStorage
}
```

**Tab auto-switching via `useEffect`**: A single `useEffect` watching `selectedTaskId` handles all 14 call sites. There are no imperative `onTaskSelected`/`onTaskDeselected` callbacks — the effect is the sole mechanism for auto-switching.

The effect reads `activeTab` and `lastTaskTab` but must **not** list them as dependencies — the intent is "run when `selectedTaskId` changes, reading the latest tab state." To avoid stale closures, store both in refs and read from the refs inside the effect:

```typescript
const activeTabRef = useRef(activeTab);
activeTabRef.current = activeTab;

const lastTaskTabRef = useRef(lastTaskTab);
lastTaskTabRef.current = lastTaskTab;

useEffect(() => {
   const currentTab = activeTabRef.current;
   const currentLastTaskTab = lastTaskTabRef.current;

   if (selectedTaskId) {
      // Task selected: switch to last task tab (opens panel if collapsed)
      if (currentTab === "home" || currentTab === null) {
         setActiveTab(currentLastTaskTab);
      }
      // If already on a task-tied tab, stay there (task-to-task switch)
   } else {
      // Task deselected: switch to home, but only if currently on a task-tied tab.
      // If activeTab is null (panel collapsed), stay collapsed — respect the user's
      // deliberate collapse. The "home" conceptual state is implied.
      if (currentTab !== null && currentTab !== "home") {
         setActiveTab("home");
      }
   }
}, [selectedTaskId]);
```

**`activeTab: null` semantics**: `null` means the side panel is collapsed (no panel content visible). The main view is unaffected — it still depends on `selectedCard`. When `activeTab` is `null`:
- Selecting a task opens the panel with `lastTaskTab`
- Deselecting a task keeps the panel collapsed (does not auto-open to "home")
- The sidebar toolbar buttons still reflect which tab would be active via a `visualActiveTab` derived value, even though the panel is closed:

```typescript
const visualActiveTab: SidebarTabId = activeTab ?? (selectedCard ? lastTaskTab : "home");
```

`visualActiveTab` is passed to `SidebarToolbar` as the visual highlight indicator. It is never used for logic — only for which button appears "active" in the icon strip.

### 5. Side Panel Content

The side panel container renders one of 4 components based on `activeTab`:

| Tab | Component | Data source | Changes needed |
|---|---|---|---|
| `home` | `ProjectNavigationPanel` | `useProjectNavigation` (existing) | Remove standalone resize/collapse logic (`useProjectNavigationLayout`). Remove the collapsed avatar view. The panel fills the side panel slot at whatever ratio-based width it's given. The internal "Projects" / "Agent" section toggle stays as-is. `ShortcutsCard` stays in the Home tab side panel for now; it is a candidate for relocation to a dedicated shortcuts panel or settings page in a follow-up. |
| `task_column` | `ColumnContextPanel` | `selectedCard`, board state | **No changes**. Already receives `selection: CardSelection` and renders in a side panel. Only rendered when `selectedCard` exists. |
| `changes` | Diff viewer (file tree + diff content) | `useRuntimeWorkspaceChanges(selectedCard.card.id, ...)` | **Extract from `CardDetailView`**. Dependencies: `useRuntimeWorkspaceChanges` hook, `selectedPath`/`setSelectedPath` state, `diffComments`/`setDiffComments` state, `diffMode`/`setDiffMode` state, `detailDiffFileTreeRatio`/`setDetailDiffFileTreeRatio` from layout hook. Sub-components: `DiffToolbar`, `FileTreePanel`, `DiffViewerPanel`, `ResizeHandle`. Props from parent: `selection`, `isDiffExpanded`, `onToggleDiffExpand`. |
| `files` | File browser | `FileBrowserPanel(taskId, baseRef, workspaceId)` | **Extract from `CardDetailView`**. Dependencies: `fileBrowserSelectedPath`/`setFileBrowserSelectedPath` state, `detailFileBrowserTreeRatio`/`setDetailFileBrowserTreeRatio` from layout hook, `fileBrowserContent` memo, `runtimeFiles` from workspace changes. Sub-components: `FileBrowserToolbar`, `FileBrowserPanel`, `ResizeHandle`. Props from parent: `selection`, `isFileBrowserExpanded`, `onToggleFileBrowserExpand`. |

### 6. Main View Content

**Home main view** (no task):
- `QuarterdeckBoard` (existing, same props)
- `GitHistoryView` (existing, toggled via `isGitHistoryOpen`)
- Home terminal (`ResizableBottomPane` + `AgentTerminalPanel`)

**Task main view** (task selected):
- `AgentTerminalPanel` with `taskId={selectedCard.card.id}` (the agent chat)
- Expanded diff view (when `isDiffExpanded`)
- Expanded file browser (when `isFileBrowserExpanded`)
- Detail terminal (`ResizableBottomPane` + `AgentTerminalPanel`)
- Git history panel (when `isGitHistoryOpen`)

### 7. Terminal Session Safety

Research confirmed terminal sessions survive component remounting:

- `PersistentTerminal` instances live in a **module-level `Map`** in `persistent-terminal-manager.ts`, keyed by `"${workspaceId}:${taskId}"`.
- On unmount, the terminal DOM is **parked** in a hidden root div (`#kb-persistent-terminal-parking-root`). WebSocket connections stay open.
- On remount, `ensurePersistentTerminal()` returns the existing instance; `mount()` reparents the DOM element.

**Invariants that must hold**:
1. `taskId` prop values must stay identical (home: `"__home_terminal__"`, detail: `"__detail_terminal__:<cardId>"`)
2. `workspaceId` must stay identical (`currentProjectId`)
3. `enabled` prop must not spuriously become `false` during transitions — that calls `disposePersistentTerminal()` which destroys WebSockets

### 8. Keyboard Shortcuts

All shortcuts in `use-app-hotkeys.ts` use `selectedCard` to determine home vs detail context. Since `selectedCard` semantics don't change (still `null` when no task, non-null when task), **no changes needed to hotkey logic** for Cmd+J, Cmd+M, Cmd+G, or Cmd+B.

**Escape key handling** requires consolidation. Currently two separate handlers exist:
- `CardDetailView` (`useWindowEvent` keydown handler): handles git history close, file browser collapse, diff collapse — only active when a task is selected
- `use-app-hotkeys.ts` (`useHotkeys("escape")`): handles home git history close — only active when `!selectedCard`

After the restructure, Escape handling lives in a **single handler at the `App.tsx` level** (or a dedicated `useEscapeHandler` hook called from `App.tsx`). The handler needs access to: `isDiffExpanded`, `isFileBrowserExpanded`, `isGitHistoryOpen`, and `selectedCard`.

**Priority chain** (first match wins):
1. **Git history open** → close git history (applies in both home and task contexts)
2. **File browser expanded** → collapse file browser (task context only)
3. **Diff expanded** → collapse diff (task context only)
4. **Task selected** → deselect task (`setSelectedTaskId(null)`) — **NEW BEHAVIOR**: This step does not exist in the current codebase. The current `CardDetailView` Escape handler only handles git history, file browser, and diff collapse — never deselection. This is an intentional addition that provides keyboard-driven navigation back to the board.

The existing guards are preserved: skip if `event.defaultPrevented`, skip if inside a dialog (`isEventInsideDialog`), skip if typing in an input/textarea (for steps 2-4; step 1 fires even during typing, matching current behavior).

**xterm interaction note for step 4**: When the agent terminal has focus, xterm may capture Escape in certain modes (e.g., alt buffer / application mode). Step 4 only fires when the terminal does not have focus or is not capturing the key (i.e., `event.defaultPrevented` is false). This is safe because xterm calls `preventDefault()` on keys it consumes.

The `use-app-hotkeys.ts` Escape handler for home git history can be removed once the unified handler covers both contexts.

### 9. ProjectNavigationPanel Adaptations

The panel currently manages its own width via `useProjectNavigationLayout` (pixel-based, 200-600px, collapsible to 48px `COLLAPSED_WIDTH`).

**Changes**:
- **Remove**: All resize logic in `project-navigation-panel.tsx` (`useProjectNavigationLayout` hook usage, `isDragging`, `dragRef`, `startDrag`, `handleMouseMove`, `handleMouseUp`, the resize separator div)
- **Remove**: The collapsed view (the `if (isCollapsed)` branch with single-letter avatars)
- **Remove**: Width constants (`COLLAPSED_WIDTH`, `SIDEBAR_COLLAPSE_THRESHOLD`, `SIDEBAR_MIN_EXPANDED_WIDTH`, `SIDEBAR_MAX_EXPANDED_WIDTH`)
- **Remove**: The outer `<aside>` wrapper with inline `style={{ width: sidebarWidth }}` — the panel fills its parent (the side panel slot)
- **Keep**: Everything else — project list, section tabs, agent section, `ShortcutsCard`, add/remove project dialogs

After cleanup, `ProjectNavigationPanel` becomes a simpler component that fills whatever container it's in.

`useProjectNavigationLayout` hook and its localStorage keys (`kb-sidebar-width`, `quarterdeck.project-navigation-panel-collapsed`) become dead code.

### 10. What CardDetailView Becomes

After extracting the sidebar and side panel, `CardDetailView` becomes a **main view component** that only renders:
- The agent terminal panel (main content area)
- Expanded diff overlay (when `isDiffExpanded`)
- Expanded file browser overlay (when `isFileBrowserExpanded`)
- Bottom terminal pane
- Git history panel

It no longer owns:
- `DetailToolbar` (moved to `App.tsx`)
- Side panel content switching
- Side panel resize handle
- `useCardDetailLayout` for panel selection (moved to `App.tsx`)

It still needs:
- `selectedCard` / `selection` — for the agent terminal
- `currentProjectId` — for tRPC calls
- `sessionSummary` — for agent terminal state
- All bottom terminal props
- Diff/file browser expanded state and data

The component can be renamed to `TaskMainView` for clarity.

**`detailSession` derivation stays in `App.tsx`**: The existing logic `sessions[selectedCard.card.id] ?? createIdleTaskSession(selectedCard.card.id)` remains in `App.tsx` and the result is passed to `TaskMainView` as the `sessionSummary` prop. The `createIdleTaskSession` fallback ensures `sessionSummary` is always non-null when `selectedCard` exists, so the conditional for rendering `TaskMainView` is just `selectedCard` (not `selectedCard && detailSession`).

**Dependencies that must move with the extraction** (not line numbers, which will shift):
- **Hooks**: `useCardDetailLayout` (resize ratios only, panel selection moves up), `useResizeDrag`, `useRuntimeWorkspaceChanges`, `useTaskWorkspaceInfoValue`, `useTaskWorkspaceStateVersionValue`, `useWindowEvent` (for Escape handling within task view)
- **State**: `selectedPath`, `fileBrowserSelectedPath`, `diffComments`, `diffMode`, `isDiffExpanded`, `isFileBrowserExpanded`
- **Sub-components**: `AgentTerminalPanel`, `DiffViewerPanel`, `FileBrowserPanel`, `FileTreePanel`, `DiffToolbar`, `FileBrowserToolbar`, `ResizableBottomPane`, `ResizeHandle`
- **Props from parent**: `selection: CardSelection`, `currentProjectId`, `sessionSummary: RuntimeTaskSessionSummary`, `taskSessions`, `gitHistoryPanel`, `onCloseGitHistory`, all bottom terminal props
- **Callbacks**: `handleToggleDiffExpand`, `handleToggleFileBrowserExpand`, Escape key handler for diff/file-browser collapse

## What Could Break

### Risk: Layout shift when switching between Home and task-tied tabs

**Concern**: Board uses horizontal columns benefiting from max width; agent terminal is single-column.
**Mitigation**: Side panel ratio persists and applies uniformly. Board already handles variable widths with flex layout.

### Risk: ProjectNavigationPanel losing resize/collapse

**Concern**: Standalone drag-to-resize and collapse-to-48px goes away.
**Mitigation**: Ratio-based resize via `ResizeHandle` replaces it. Clicking active tab toggles side panel closed. Avatar-collapsed view is nice-to-have, not critical.

### Risk: `enabled` prop spuriously false during transitions

**Concern**: If component hierarchy changes cause `AgentTerminalPanel` to briefly render with `enabled={false}`, the terminal's WebSocket connections are destroyed.
**Mitigation**: Ensure `enabled` is derived from the same conditions as today. The task agent terminal uses `isTaskTerminalEnabled = column.id === "in_progress" || column.id === "review"` — this doesn't change. The shell terminals have no `enabled` gating.

### Risk: Escape key handler ownership

**Concern**: Escape handlers in `CardDetailView` need to move with the panels they control.
**Mitigation**: Diff/file-browser collapse handlers co-locate with the expanded state that controls them. The `isDiffExpanded` / `isFileBrowserExpanded` state lives wherever the expand button lives.

### Risk: Board unmount losing scroll position

**Concern**: The `visibility: hidden` pattern kept the board mounted. Now it unmounts.
**Mitigation**: Acceptable trade-off. Board scroll position is rarely deep enough to matter. Can add scroll position ref later if needed.

### Risk: `handleOpenEditTask` deselects and shows board

**Concern**: `use-task-editor.ts` `handleOpenEditTask` calls `setSelectedTaskId(null)` when opening the inline editor. The `useEffect` in section 4 would switch to Home tab automatically. This is correct — the board needs to be visible for the inline editor in the backlog column.
**Mitigation**: This is actually the desired behavior. No special handling needed.

## Implementation Order

### Phase 1: Extract sidebar from CardDetailView

1. Add `SidebarTabId` type (`"home" | "task_column" | "changes" | "files"`) to `use-card-detail-layout.ts`
2. Add `lastTaskTab` localStorage key and load/persist functions
3. Update `loadActivePanel` with localStorage migration (`"quarterdeck"` → `"home"`)
4. Add Home button + divider to `DetailToolbar`, add `hasSelectedTask` prop for disabled states
5. Extract side panel content (Task Column, Changes, Files JSX) from `CardDetailView` into standalone components or render functions
6. Create the unified sidebar structure in `App.tsx`: toolbar + side panel always rendered
7. Move `ProjectNavigationPanel` from standalone `<aside>` into the Home tab side panel slot
8. `CardDetailView` becomes `TaskMainView` — only agent terminal + expanded overlays + bottom terminal

### Phase 2: Wire main view and tab switching

1. Main view in `App.tsx` conditionally renders board (home) or `TaskMainView` (task selected)
2. Remove `kb-home-layout` div, `visibility: hidden` pattern, and absolute-positioned overlay
3. Add `useEffect` for tab auto-switching on task select/deselect (see section 4)
4. Verify that the `useEffect` correctly handles all 14 `setSelectedTaskId` call sites — no imperative `onTaskSelected`/`onTaskDeselected` callbacks are needed since the effect watches `selectedTaskId` reactively
5. Consolidate Escape key handlers from `CardDetailView` and `use-app-hotkeys.ts` into a single unified handler (see section 8)

### Phase 3: Clean up

1. Remove resize/collapse logic from `ProjectNavigationPanel` (the `useProjectNavigationLayout` usage, collapsed view branch, width constants, resize separator)
2. Delete `useProjectNavigationLayout` hook (or mark unused)
3. Rename: `DetailPanelId` → `SidebarTabId`/`TaskTabId`, `DetailToolbar` → `SidebarToolbar`, `ColumnContextPanel` → `TaskColumnPanel`
4. Update `docs/ui-component-cheatsheet.md` and `docs/todo.md`
5. Update any tests that reference renamed types/components
6. Add unit tests for `loadActiveTab` localStorage migration (see section 1)

## Out of Scope

- Project switcher as its own tab (#10) — future work after this lands
- Board as its own non-home tab — future work
- Git management panel (#14) — future work
- File browser working without a task (workspace-level file browsing) — greyed out for now
- Changes panel working without a task (branch diffing) — greyed out for now
- Quarterdeck Agent location redesign — stays in Home tab side panel for now

## Success Criteria

1. All 16 functional verification steps pass
2. `npm run check` passes (lint + typecheck + tests)
3. `npm run build` succeeds
4. No terminal session loss when switching between Home and task views
5. Existing localStorage values from before the change load without errors
6. No visual regressions on the board, task column, changes, or files panels

## Naming Glossary

See `docs/ui-component-cheatsheet.md` for the full mapping. Key terms:

- **Sidebar**: Thin vertical icon strip with tab buttons (40px wide)
- **Side Panel**: Resizable panel next to the sidebar showing tab content
- **Main View**: Large content area right of the side panel
- **Top Bar**: Horizontal bar across the top
- **Home Tab**: Sidebar tab showing project nav + board
- **Task Column**: Sidebar tab showing compact stacked columns (was `ColumnContextPanel`)
- **Agent Terminal**: Task's chat/terminal in the main view
- **Home Terminal**: Bottom terminal on home view
- **Detail Terminal**: Bottom terminal on task detail view
