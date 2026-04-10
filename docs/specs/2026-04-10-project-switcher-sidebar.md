# Project Switcher Sidebar

**Date**: 2026-04-10
**Status**: Draft
**Addresses**: Todo #6 (project switcher in detail toolbar), Todo #16 (notification badges), Todo #19 (task count sync)

## Goal

Make switching between projects as easy as switching between tasks. Today you must click Home (which deselects the current task) to see the project list. After this change, a dedicated Projects icon in the sidebar toolbar opens the project panel from any context — home view, task terminal, diff viewer — without disrupting your current work.

## End State

### Toolbar layout

```
┌────────────┐
│  Home       │  always enabled (unchanged)
│  Projects   │  always enabled (NEW)
│─────────────│
│  Board      │  task-only
│  Changes    │  task-only
│  Files      │  always enabled
└─────────────┘
```

Home stays as-is. A new **Projects** button is added between Home and the divider.

### What "Projects" shows

Clicking the Projects toolbar icon opens the **existing ProjectNavigationPanel** in the sidebar — same component, same internal "Projects" / "Quarterdeck Agent" tab toggle, same project list with task count badges, add button, remove dialog, onboarding tips, shortcuts, and beta notice. No visual redesign of the panel itself.

### Behavior rules

| Action | Result |
|--------|--------|
| Click Projects icon (sidebar closed or different tab) | Opens sidebar with ProjectNavigationPanel |
| Click Projects icon (already showing Projects) | Collapses sidebar (toggle off) |
| Click Projects icon while a task is selected | Opens project sidebar. **Task stays selected.** Terminal/main content remains visible. |
| Click a different project in the list | Switches project — task deselects, board reloads (existing behavior). Active tab stays on "projects". |
| Click the same (current) project in the list | No-op (existing behavior) |
| Click Home icon | Switches to Home. **Deselects task** (existing behavior, unchanged). |
| Task deselected (via Home or project switch) | If sidebar was on `task_column` or `changes`, switches to `home`. If on `projects` or `files` or `null`, stays put. |
| App opens fresh | Defaults to `home` tab (existing behavior, unchanged). |

**Key difference from Home tab**: Clicking Projects does NOT deselect the task. Only actually switching to a different project deselects (because tasks are project-scoped).

### Notification badge on Projects icon

The Projects toolbar button shows a badge when any project has an agent needing attention:

- **Orange badge**: Any task across ANY project is in the `isApprovalState` — i.e., `state === "awaiting_review"` AND `reviewReason === "hook"` AND the hook is a permission request. This indicates the user needs to grant approval.

Data source: `notificationSessions` from `useRuntimeStateStream`. This is already cross-project — `task_notification` messages are not filtered by `activeWorkspaceId`. We check `isApprovalState()` from `utils/session-status.ts` against each session.

### Real-time task count badges (Todo #19)

The `(B 2) (IP 1) (R 3)` badges on project rows in the sidebar must update in real-time when task states change.

**Current state**: The backend already broadcasts `projects_updated` messages (with fresh `taskCounts`) every time task sessions are flushed (`flushTaskSessionSummaries` in `runtime-state-hub.ts` calls `broadcastRuntimeProjectsUpdated` at line 156). It also broadcasts after `saveState` and `notifyStateUpdated` in workspace-api.ts. So the data IS being sent.

**Investigation needed**: If the badges are stale, the bug is likely on the frontend — either the `projects_updated` reducer isn't re-rendering project rows, or the project rows are receiving stale snapshots. Verify by:
1. Confirming `projects_updated` messages arrive on the WebSocket when a task changes state
2. Checking if the `projects` array reference changes in the reducer (triggering re-render)
3. Checking if `ProjectNavigationPanel` re-renders when `projects` prop changes

If the data flow is already working, the fix may be as simple as ensuring the `projects` prop from App.tsx uses the live `projects` array from the stream rather than a stale snapshot.

## Implementation

### Files to modify

#### 1. `web-ui/src/resize/use-card-detail-layout.ts` — Add "projects" to tab system

- Add `"projects"` to `SidebarTabId`: `"home" | "projects" | TaskTabId`
- Update `loadActiveTab()` to recognize `"projects"` from localStorage
- Update `handleTabChange`:
  - `"projects"` case: set active tab to `"projects"`, do NOT call `setSelectedTaskId(null)`
  - This is the key behavioral difference from `"home"` which deselects
- Update auto-switch effect (`useEffect` on `selectedTaskId`):
  - When task deselected: if on `task_column` or `changes` → switch to `"home"` (unchanged)
  - If on `"projects"`, `"files"`, or `null` → stay put (add `"projects"` to the stay-put list)

#### 2. `web-ui/src/components/detail-panels/detail-toolbar.tsx` — Add Projects button

- Import icon (e.g., `FolderKanban` from lucide-react)
- Add `projectsBadgeColor` prop to `DetailToolbarProps`
- Add `ToolbarButton` for `"projects"` after Home, before the divider
- Always enabled (no `disabled` prop)
- Pass `badgeColor={projectsBadgeColor}` for the notification badge

#### 3. `web-ui/src/App.tsx` — Render project sidebar for "projects" tab

- In the sidebar rendering block (around line 1202), add `activeTab === "projects"` case
- Render ProjectNavigationPanel with the same props as the Home case
- This must work in TWO contexts:
  - **No task selected**: rendered in App.tsx sidebar area (same as Home)
  - **Task selected**: rendered in App.tsx sidebar area, BEFORE `CardDetailView`. CardDetailView sees `activeTab === "projects"` → `isTaskSidePanelOpen` is false → renders only main content (terminal).

The key architectural insight: the sidebar rendering in App.tsx happens as a sibling to CardDetailView in the flex row. When `activeTab === "projects"`, App.tsx renders `<ProjectNavigationPanel>` + `<ResizeHandle>` in the sidebar slot, and CardDetailView renders the main content (terminal/review) without its own sidebar.

- Compute `projectsBadgeColor` from `notificationSessions`:
  ```ts
  const hasApprovalNeeded = Object.values(notificationSessions).some(isApprovalState);
  const projectsBadgeColor = hasApprovalNeeded ? "orange" : undefined;
  ```
- Pass `projectsBadgeColor` to `DetailToolbar`

#### 4. `web-ui/src/components/card-detail-view.tsx` — No changes needed

`isTaskSidePanelOpen` already only matches `task_column | changes | files`. When `activeTab === "projects"`, this is false, so CardDetailView renders no sidebar — the project sidebar is rendered by App.tsx. No code change required here.

#### 5. Badge color support — Possibly update `detail-toolbar.tsx` badge colors

Current badge colors are `"red" | "blue"`. Need to add `"orange"` for the approval badge:
```ts
badgeColor === "orange" ? "bg-status-orange" : ...
```

### Files NOT modified

- `project-navigation-panel.tsx` — No changes. Reused as-is.
- Backend (`src/`) — No changes for the core feature. Task count sync investigation may reveal a frontend-only fix.

## Verification

1. **Manual testing**:
   - Open app → Home tab is active, project sidebar shows (unchanged)
   - Click Projects icon → sidebar shows ProjectNavigationPanel
   - Click a task → task opens in main area, sidebar stays on Projects
   - Click Board icon → sidebar switches to column context panel
   - Click Projects icon → sidebar switches back to project list, task still selected
   - Click a different project → project switches, task deselects, board reloads
   - Click Projects icon again → sidebar collapses (toggle off)

2. **Badge testing**:
   - Start a task, wait for it to hit a permission prompt
   - If on a different project or different sidebar tab, Projects icon should show orange badge

3. **Task count sync testing**:
   - Have project sidebar open, create/start/complete tasks
   - The (B, IP, R, T) badges on the project row should update within ~1 second

4. **Automated**:
   - `npm run web:typecheck` — no type errors from new SidebarTabId value
   - `npm run test:fast` — existing tests pass
   - `npm run web:test` — existing web-ui tests pass
