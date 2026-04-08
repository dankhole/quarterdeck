# Cross-Workspace Audible Notifications

## Overview

Audible notifications (permission, review, completion, failure) only fire for tasks in the currently viewed project. When the user switches to a different project via the project switcher, session updates from the previous project stop reaching the browser entirely. This plan adds a dedicated cross-workspace notification channel so the audible notification hook receives session transitions from ALL projects, regardless of which one is currently being viewed.

## Current State

Session updates flow through a workspace-scoped pipeline:

1. **Server**: `flushTaskSessionSummaries` (`src/server/runtime-state-hub.ts:113-132`) sends `task_sessions_updated` only to clients in `runtimeStateClientsByWorkspaceId.get(workspaceId)`. The client is only registered for the workspace it's currently viewing.

2. **Client stream**: `use-runtime-state-stream.ts:337-340` filters `task_sessions_updated` by `activeWorkspaceId`, dropping any messages that somehow arrive for other workspaces.

3. **Client state**: On project switch, the WebSocket closes and reconnects for the new workspace (`use-runtime-state-stream.ts:243-281`). The old workspace's sessions are replaced by the new workspace's snapshot.

4. **Notification hook**: `use-audible-notifications.ts:121-131` fully resets on workspace switch — clears column tracking, sets `isInitialLoadRef = true`, cancels pending sounds.

**Result**: Any task transition (permissions, completion, error) in a non-viewed project is invisible to the notification system.

**Existing cross-workspace pattern**: `broadcastRuntimeProjectsUpdated` (`runtime-state-hub.ts:95-111`) sends to `runtimeStateClients` (ALL connected clients regardless of workspace). This already fires after every `flushTaskSessionSummaries` batch (line 131). The `projects_updated` message carries aggregate `taskCounts` for all projects.

## Desired End State

- Audible notifications fire for ALL projects, not just the currently viewed one
- A task needing permissions in Project B plays the permission sound even while the user is viewing Project A
- The notification hook tracks session columns globally across all workspaces
- Workspace-scoped board state (`sessions` in App.tsx) is NOT polluted with cross-workspace data
- Existing per-event toggles, volume, and `onlyWhenHidden` settings continue to work

**Verification**: Start tasks in two different projects. Switch to the second project. When a task in the first project transitions (e.g., needs permissions or completes), the appropriate notification sound plays.

## Out of Scope

- Cross-workspace OS notifications (`use-review-ready-notifications.ts`) — separate concern, can be addressed later using the same `task_notification` channel
- Per-project notification settings (e.g., mute notifications for a specific project)
- Visual cross-workspace notification badges (project badges already show aggregate counts via `projects_updated`)
- Cross-workspace `task_ready_for_review` or `task_title_updated` broadcasts

## Dependencies

None. This is a self-contained change across server, API contract, client stream, and notification hook.

## Implementation Approach

Add a new `task_notification` message type to the WebSocket protocol. The server broadcasts it to ALL connected clients (via `runtimeStateClients`) alongside the existing workspace-scoped `task_sessions_updated`. The client receives it without workspace filtering and stores summaries in a separate `notificationSessions` map. The audible notification hook is rewired to use this global map instead of the workspace-scoped `sessions`, and its workspace-switch reset logic is removed since it now tracks all workspaces continuously.

This follows the established `projects_updated` pattern for cross-workspace data and keeps the notification data flow cleanly separated from workspace-scoped board state.

---

## Phase 1: API Contract & Server Broadcast

### Overview

Define the new `task_notification` message type and add a server broadcast function that sends session summaries to all connected clients.

### Changes Required

#### 1. Message type schema

**File**: `src/core/api-contract.ts`

Add a new schema to the `RuntimeStateStreamMessage` discriminated union:

```typescript
export const runtimeStateStreamTaskNotificationMessageSchema = z.object({
   type: z.literal("task_notification"),
   workspaceId: z.string(),
   summaries: z.array(runtimeTaskSessionSummarySchema),
});
export type RuntimeStateStreamTaskNotificationMessage = z.infer<typeof runtimeStateStreamTaskNotificationMessageSchema>;
```

Add it to the `runtimeStateStreamMessageSchema` union (around line 409).

**Design note**: Uses `summaries: []` (array) rather than a single summary to match the batching behavior of `task_sessions_updated`. The server batches session updates per workspace on a 150ms timer — the notification broadcast should send the same batch rather than individual messages.

#### 2. Server broadcast function

**File**: `src/server/runtime-state-hub.ts`

Add `broadcastTaskNotification` that sends to `runtimeStateClients` (all clients):

```typescript
const broadcastTaskNotification = (workspaceId: string, summaries: RuntimeTaskSessionSummary[]) => {
   if (runtimeStateClients.size === 0) {
      return;
   }
   const payload: RuntimeStateStreamTaskNotificationMessage = {
      type: "task_notification",
      workspaceId,
      summaries,
   };
   for (const client of runtimeStateClients) {
      sendRuntimeStateMessage(client, payload);
   }
};
```

Call it from `flushTaskSessionSummaries` (line 113-132), right after the workspace-scoped broadcast and before the `broadcastRuntimeProjectsUpdated` call:

```typescript
const flushTaskSessionSummaries = (workspaceId: string) => {
   // ... existing workspace-scoped broadcast ...

   // Broadcast to ALL clients for cross-workspace notifications.
   broadcastTaskNotification(workspaceId, summaries);

   void broadcastRuntimeProjectsUpdated(workspaceId);
};
```

The `summaries` array is already built on line 119 — reuse it.

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Runtime tests pass: `npm run test:fast`

#### Manual

- [ ] Open browser dev tools Network tab, filter WebSocket frames. Verify `task_notification` messages arrive for both the active workspace and other workspaces when tasks transition.

**Checkpoint**: Verify `task_notification` messages appear in WebSocket frames before proceeding.

---

## Phase 2: Client Stream Integration

### Overview

Accept `task_notification` messages in the runtime state stream without workspace filtering. Store them in a new `notificationSessions` state field separate from the workspace-scoped board sessions.

### Changes Required

#### 1. Stream store state

**File**: `web-ui/src/runtime/use-runtime-state-stream.ts`

Add to `RuntimeStateStreamStore` interface (around line 53):

```typescript
notificationSessions: Record<string, RuntimeTaskSessionSummary>;
```

Initialize to `{}` in `createInitialRuntimeStateStreamStore` (around line 90).

Add to `RuntimeStateStreamAction` union:

```typescript
| { type: "task_notification"; summaries: RuntimeTaskSessionSummary[] }
```

Add reducer case (no workspace filter):

```typescript
if (action.type === "task_notification") {
   return {
      ...state,
      notificationSessions: mergeTaskSessionSummaries(state.notificationSessions, action.summaries),
   };
}
```

The existing `mergeTaskSessionSummaries` helper (line 17-32) already handles monotonic merging by `updatedAt` — reuse it directly.

#### 2. WebSocket message handler

**File**: `web-ui/src/runtime/use-runtime-state-stream.ts`

Add handler in the `onmessage` callback (around line 337-346), with NO workspace ID filter:

```typescript
if (payload.type === "task_notification") {
   dispatch({
      type: "task_notification",
      summaries: payload.summaries,
   });
   return;
}
```

#### 3. Handle snapshot initialization

When a `snapshot` arrives (line 136-156), also seed `notificationSessions` from the workspace state's sessions so the notification hook has initial column data for the active workspace:

```typescript
if (action.type === "snapshot") {
   const snapshotSessions = action.payload.workspaceState?.sessions ?? {};
   return {
      ...state,
      // ... existing snapshot fields ...
      notificationSessions: mergeTaskSessionSummaries(state.notificationSessions, Object.values(snapshotSessions)),
   };
}
```

**Note**: We merge rather than replace because `notificationSessions` may already contain sessions from other workspaces that were received before the snapshot.

#### 4. Handle `requested_workspace_changed`

When the workspace changes (line 118-127), do NOT clear `notificationSessions`. This is the key difference from workspace-scoped state — notification sessions persist across project switches.

#### 5. Expose through stream result

**File**: `web-ui/src/runtime/use-runtime-state-stream.ts`

Add `notificationSessions` to the `UseRuntimeStateStreamResult` interface and the returned object.

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run web:typecheck`
- [ ] Web UI tests pass: `npm run web:test`

#### Manual

- [ ] Add `console.log` in the `task_notification` handler. Switch projects. Verify session updates from both workspaces appear in the console.

**Checkpoint**: Verify `notificationSessions` accumulates sessions from all workspaces before proceeding.

---

## Phase 3: Notification Hook Refactor

### Overview

Switch `useAudibleNotifications` from workspace-scoped `sessions` to global `notificationSessions`. Remove workspace-switch reset logic since the hook now tracks all workspaces continuously.

### Changes Required

#### 1. Update hook interface

**File**: `web-ui/src/hooks/use-audible-notifications.ts`

Replace the workspace-scoped inputs:

```typescript
// Remove:
activeWorkspaceId: string | null;
taskSessions: Record<string, RuntimeTaskSessionSummary>;

// Replace with:
notificationSessions: Record<string, RuntimeTaskSessionSummary>;
```

#### 2. Remove workspace-switch reset logic

**File**: `web-ui/src/hooks/use-audible-notifications.ts`

Remove entirely:
- `previousWorkspaceIdRef` (line 103)
- The workspace-switch `useEffect` (lines 121-131) that clears `previousColumnsRef`, sets `isInitialLoadRef`, and cancels pending sounds

The hook no longer needs to know which workspace is active — it monitors all sessions globally.

#### 3. Simplify the main detection effect

**File**: `web-ui/src/hooks/use-audible-notifications.ts`

Remove `activeWorkspaceId` from the effect's dependency array and the early return when it's null. The effect now runs purely based on `notificationSessions` changes:

```typescript
useEffect(() => {
   const previousColumns = previousColumnsRef.current;

   if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      for (const [taskId, summary] of Object.entries(notificationSessions)) {
         previousColumns.set(taskId, deriveColumn(summary));
      }
      return;
   }

   // ... rest of detection logic unchanged, using notificationSessions ...
}, [audibleNotificationsEnabled, audibleNotificationsOnlyWhenHidden, notificationSessions]);
```

`isInitialLoadRef` is still needed for the very first render (to avoid playing sounds for sessions that were already stopped when the page loaded), but it no longer resets on workspace switch.

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run web:typecheck`
- [ ] Audible notification tests pass (will need updates — see Phase 4)

#### Manual

- [ ] N/A — full manual testing in Phase 4

**Checkpoint**: Code compiles and the hook's interface is simplified. Tests will be updated in Phase 4.

---

## Phase 4: Wiring & Tests

### Overview

Wire the new `notificationSessions` from the stream to the notification hook in `App.tsx`. Update all existing tests to match the new interface and add a cross-workspace notification test.

### Changes Required

#### 1. App.tsx wiring

**File**: `web-ui/src/App.tsx`

Replace the current `taskSessions: sessions` prop with `notificationSessions` from the stream:

```typescript
// From use-runtime-state-stream result:
const { notificationSessions, ... } = useRuntimeStateStream(...);

useAudibleNotifications({
   notificationSessions,
   audibleNotificationsEnabled,
   audibleNotificationVolume,
   audibleNotificationEvents,
   audibleNotificationsOnlyWhenHidden,
});
```

Remove `activeWorkspaceId: activeNotificationWorkspaceId` from the hook call.

#### 2. Update existing tests

**File**: `web-ui/src/hooks/use-audible-notifications.test.tsx`

- Remove `activeWorkspaceId` from the `HookProps` interface and `defaultProps()`
- Replace `taskSessions` prop with `notificationSessions`
- Remove the "clears state on workspace switch" test (workspace switch no longer affects the hook)
- Remove the "does not play when activeWorkspaceId is null" test (no longer relevant)
- Update all remaining tests to use the new prop name

#### 3. Add cross-workspace notification test

**File**: `web-ui/src/hooks/use-audible-notifications.test.tsx`

```typescript
it("plays sound for tasks from different workspaces", async () => {
   const props = defaultProps();

   // Start with a running task (simulating one workspace).
   await act(async () => {
      root.render(
         <HookHarness
            {...props}
            notificationSessions={{
               "ws1-task": createMockSession({ taskId: "ws1-task", state: "running" }),
               "ws2-task": createMockSession({ taskId: "ws2-task", state: "running" }),
            }}
         />,
      );
   });

   // Both tasks transition — one per workspace.
   await act(async () => {
      root.render(
         <HookHarness
            {...props}
            notificationSessions={{
               "ws1-task": createMockSession({
                  taskId: "ws1-task",
                  state: "awaiting_review",
                  reviewReason: "error",
               }),
               "ws2-task": createMockSession({
                  taskId: "ws2-task",
                  state: "awaiting_review",
                  reviewReason: "exit",
                  exitCode: 0,
               }),
            }}
         />,
      );
   });

   flushSettleWindow();
   expect(playMock).toHaveBeenCalledTimes(2);
   expect(playMock).toHaveBeenCalledWith("failure", 0.7);
   expect(playMock).toHaveBeenCalledWith("completion", 0.7);
});
```

### Success Criteria

#### Automated

- [ ] Full check passes: `npm run check`
- [ ] Build succeeds: `npm run build`
- [ ] All runtime tests pass: `npm run test:fast`
- [ ] All web UI tests pass: `npm run web:test`

#### Manual

- [ ] Start Quarterdeck with two projects, each with a running task
- [ ] Switch to project B while project A's task is still running
- [ ] When project A's task transitions (needs permissions, completes, errors), verify the notification sound plays
- [ ] Verify the board UI for project B is not affected (no stale sessions from A)
- [ ] Verify per-event toggles and volume settings still work
- [ ] Verify `onlyWhenHidden` setting still gates correctly

---

## Risks

- **Duplicate sounds for active workspace**: The active workspace's sessions appear in BOTH `notificationSessions` (via `task_notification`) and `sessions` (via `task_sessions_updated`). Since `useAudibleNotifications` only reads `notificationSessions`, this is not a double-fire risk. The workspace-scoped `sessions` is only used by the board UI.

- **Session ID collisions across workspaces**: Task IDs are UUIDs, so collisions are effectively impossible. The `notificationSessions` map uses `taskId` as key, which is unique per workspace. If two workspaces somehow had the same task ID, the `mergeTaskSessionSummaries` helper would keep the newer one by `updatedAt`.

- **Memory growth in `notificationSessions`**: Sessions from all workspaces accumulate without cleanup. In practice, Quarterdeck manages a small number of projects with tens of tasks each — this is negligible. If needed, a periodic cleanup could evict sessions that have been in a terminal state for more than N minutes.

- **WebSocket payload size increase**: Each `flushTaskSessionSummaries` now sends data twice — once workspace-scoped, once global. The session summary objects are small (~200 bytes each) and batched per workspace. Even with 10 concurrent agents, this is under 2KB per batch — negligible overhead.

## References

- Planned feature: `docs/planned-features.md` #23 (audible notification lag — settle window fix is a companion change)
- Audible notification hook: `web-ui/src/hooks/use-audible-notifications.ts`
- Server broadcast hub: `src/server/runtime-state-hub.ts`
- API contract: `src/core/api-contract.ts:409` (stream message union)
- Runtime state stream: `web-ui/src/runtime/use-runtime-state-stream.ts`
- Cross-workspace broadcast pattern: `broadcastRuntimeProjectsUpdated` at `runtime-state-hub.ts:95-111`
