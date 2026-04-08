# Shell Terminal Auto-Restart — Implementation Specification

**Date**: 2026-04-07
**Branch**: main
**Adversarial Review Passes**: 3
**Test Spec**: [docs/specs/2026-04-07-shell-terminal-auto-restart-tests.md](./2026-04-07-shell-terminal-auto-restart-tests.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
User terminals (non-agent) often end up in a bad state with an exit code and the terminal process
not running. Want to detect this and auto-restart the shell, reusing the existing restart button
infrastructure. Frontend-driven approach to avoid backend state transition issues. Should have a
settings toggle to disable auto-restart.
-->

## Goal

Auto-restart non-agent shell terminals (both home and detail) when they exit unexpectedly, so users don't have to manually click the restart button on a dead terminal. The feature is frontend-driven, reuses the existing restart infrastructure, includes crash-loop protection, and can be disabled via a settings toggle.

## Current State

- `web-ui/src/terminal/persistent-terminal-manager.ts:513-516` — When a shell terminal's PTY process exits, the exit handler writes `[quarterdeck] session exited with code X` to the xterm buffer and returns. No callback is fired, no subscriber is notified, no distinction is made between shell and agent sessions. The terminal panel remains open showing a dead session.
- `web-ui/src/terminal/persistent-terminal-manager.ts:38-43` — `PersistentTerminalSubscriber` has `onConnectionReady`, `onLastError`, `onSummary`, `onOutputText`. There is no `onExit` callback.
- `web-ui/src/hooks/use-terminal-panels.ts:404-413` — `handleRestartHomeTerminal` stops the session via tRPC then calls `startHomeTerminalSession()`.
- `web-ui/src/hooks/use-terminal-panels.ts:415-426` — `handleRestartDetailTerminal` stops the session via tRPC then calls `startDetailTerminalForCard(card)`.
- `src/core/api-contract.ts:248` — `RuntimeTaskSessionSummary.agentId` is `null` for shell sessions, non-null for agent sessions. This field is available on `PersistentTerminal.latestSummary` but never read by the exit handler.
- `src/config/runtime-config.ts:14-49` — Config system uses `RuntimeGlobalConfigFileShape` for persistence, `RuntimeConfigState` for runtime, `RuntimeConfigUpdateInput` for mutations. Boolean toggles follow the `readyForReviewNotificationsEnabled` pattern.
- `src/core/api-contract.ts:546-574` — Zod schemas `runtimeConfigResponseSchema` and `runtimeConfigSaveRequestSchema` define the API contract for config.
- `web-ui/src/components/runtime-settings-dialog.tsx:658-666` — Existing boolean toggle (`readyForReviewNotificationsEnabled`) uses `RadixSwitch.Root` pattern.

## Desired End State

1. When a non-agent shell terminal exits with a non-zero or null exit code, the frontend automatically restarts it after a 1-second delay, displaying `[quarterdeck] shell exited unexpectedly, restarting...` in the terminal buffer.
2. When exit code is 0 (clean exit, e.g., user typed `exit`), no auto-restart occurs — behavior is unchanged.
3. A rate limiter prevents crash loops: max 3 auto-restarts within a 30-second window. When the limit is hit, the terminal displays `[quarterdeck] shell could not be restarted automatically, click restart to try again` and stops auto-restarting.
4. A `shellAutoRestartEnabled` boolean setting (default `true`) in the global config controls whether auto-restart is active. When `false`, dead shells behave exactly as they do today.
5. The settings toggle appears in the settings dialog under a "Terminal" section heading.
6. Agent terminal exit behavior is completely unchanged.

## Out of Scope

- Backend auto-restart changes (no modifications to `session-manager.ts` auto-restart logic)
- Agent terminal auto-restart behavior changes
- Any changes to the manual restart button (it continues to work as-is, independent of auto-restart)
- Terminal reconnection on WebSocket disconnect (separate concern)
- Persisting rate-limit state across page reloads (ephemeral in-memory counter is sufficient)

## Dependencies

- **Teams**: None
- **Services**: None
- **Data**: None
- **Timing**: None

## New Dependencies & Configuration

No new packages required.

**Configuration changes:**
- `shellAutoRestartEnabled: boolean` (default `true`) added to global config file shape, runtime config state, update input, Zod schemas, and settings dialog.

## Architecture & Approach

The approach is **frontend-driven**: the `PersistentTerminal` class gains an `onExit` subscriber callback, and a new React hook (`useShellAutoRestart`) listens for exit events on shell terminals and triggers the existing restart handlers with rate limiting.

This avoids modifying the backend auto-restart path which is designed for agent sessions with different semantics (agent work to resume vs. blank shell restart). It also avoids state transition confusion (`"running" → "idle" → "running"` race conditions on the backend) and keeps the implementation contained to the frontend layer.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Frontend vs backend auto-restart | Frontend | Shell restarts are UX recovery, not work continuation. Backend auto-restart is designed for agents. Avoids `"running" → "idle" → "running"` state races. | Extend backend `shouldAutoRestart` to accept `kind: "shell"` | Frontend code MUST NOT modify backend auto-restart logic |
| Hook point | New `onExit` callback on `PersistentTerminalSubscriber` | Clean extension of existing subscriber pattern. No coupling between terminal manager and React hooks. | Polling `latestSummary` for state changes | MUST add `onExit` to subscriber interface, not hack the exit handler |
| Rate limit scope | Per-taskId, in-memory | Each terminal has independent crash-loop detection. No persistence needed — page reload resets counters, which is fine. | Global rate limit across all terminals | Rate limiter MUST track timestamps per taskId independently |
| Setting scope | Global config | Terminal behavior preference applies across all projects | Per-project config | Setting MUST be in `RuntimeGlobalConfigFileShape`, not project config |
| Clean exit detection | `exitCode === 0` means clean | Shells exit 0 on user `exit`/Ctrl-D. When the user clicks the manual restart button, `stopTaskSession` kills the PTY, which does fire an exit event to the frontend. The auto-restart hook's `isSessionRunning` guard (checked after the 1s delay) prevents double-restart in this case — by the time the timer fires, the manual restart has already started a new session. | Check if `stopTaskSession` was recently called | MUST NOT auto-restart when `exitCode === 0` |

## Implementation Phases

### Phase 1: Add `onExit` Subscriber Callback

#### Overview

Extend the `PersistentTerminal` subscriber interface with an `onExit` callback so that React hooks can react to terminal exit events. This is the foundation for Phase 2.

#### Changes Required

##### 1. Add `onExit` to subscriber interface

**File**: `web-ui/src/terminal/persistent-terminal-manager.ts`
**Action**: Modify
**Location**: `PersistentTerminalSubscriber` interface at line 38
**Changes**:
- Add `onExit?: (taskId: string, exitCode: number | null) => void;` to the interface

##### 2. Fire `onExit` in the exit handler

**File**: `web-ui/src/terminal/persistent-terminal-manager.ts`
**Action**: Modify
**Location**: Exit handler at line 513-516
**Changes**:
- After writing the exit message to the terminal buffer, call `this.notifyExit(payload.code)` (new private method)
- Add `notifyExit(code: number | null)` private method that:
  1. Checks `this.latestSummary?.agentId` — if it is non-null (agent session), returns immediately without notifying. This ensures `onExit` only fires for shell sessions, keeping the filtering centralized in the terminal manager rather than leaking it to every call site.
  2. Iterates `this.subscribers` and calls `subscriber.onExit?.(this.taskId, code)`
- Pattern to follow: see how `notifyLastError()` and `notifySummary()` are implemented in the same class (lines 276-300)

##### 3. Expose `onExit` in the session hook

**File**: `web-ui/src/terminal/use-persistent-terminal-session.ts`
**Action**: Modify
**Location**: `subscribe()` call at line 113-121
**Changes**:
- Accept an optional `onExit` callback in the hook's props/options
- Pass it through to `terminal.subscribe({ ..., onExit })`
- **`callbackRef` pattern**: `onExit` must be added to the existing `callbackRef` pattern (see `use-persistent-terminal-session.ts:43-48`) to avoid stale closures. Add `onExit` to the `callbackRef.current` object alongside `onSummary` and `onConnectionReady`, and pass `callbackRef.current.onExit` to the subscriber instead of `onExit` directly.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Web UI tests pass: `npm run web:test`
- [ ] Typecheck passes: `npm run web:typecheck`

##### Behavioral

- [ ] Open a shell terminal, type `exit 1` — the `onExit` callback fires with `exitCode: 1` (verify via console.log in dev)
- [ ] Open a shell terminal, type `exit` — the `onExit` callback fires with `exitCode: 0`

**Checkpoint**: Pause here for verification before proceeding to Phase 2.

---

### Phase 2: Settings Toggle

#### Overview

Add the `shellAutoRestartEnabled` boolean setting to the config system and settings dialog. This must exist before Phase 3 so the auto-restart logic can read the setting.

#### Changes Required

##### 1. Config file shape and state

**File**: `src/config/runtime-config.ts`
**Action**: Modify
**Changes**:
- Add `shellAutoRestartEnabled?: boolean` to `RuntimeGlobalConfigFileShape` (line 14)
- Add `shellAutoRestartEnabled: boolean` to `RuntimeConfigState` (line 27)
- Add `shellAutoRestartEnabled?: boolean` to `RuntimeConfigUpdateInput` (line 41)
- Add `const DEFAULT_SHELL_AUTO_RESTART_ENABLED = true;` near other defaults (line 56)
- Add normalization in the config loading logic: `shellAutoRestartEnabled: normalizeBoolean(global.shellAutoRestartEnabled, DEFAULT_SHELL_AUTO_RESTART_ENABLED)`
- Add to the write/merge logic in `writeRuntimeGlobalConfigFile`

**Code Pattern to Follow**: See `readyForReviewNotificationsEnabled` at `src/config/runtime-config.ts:18,33,45,57` — follow the exact same pattern for each layer.

##### 2. Zod schemas

**File**: `src/core/api-contract.ts`
**Action**: Modify
**Changes**:
- Add `shellAutoRestartEnabled: z.boolean()` to `runtimeConfigResponseSchema` (line 546)
- Add `shellAutoRestartEnabled: z.boolean().optional()` to `runtimeConfigSaveRequestSchema` (line 565)

##### 3. Response builder

**File**: `src/terminal/agent-registry.ts`
**Action**: Modify
**Location**: `buildRuntimeConfigResponse` function (line 96)
**Changes**:
- Add `shellAutoRestartEnabled: runtimeConfig.shellAutoRestartEnabled` to the response object

##### 4. Settings dialog

**File**: `web-ui/src/components/runtime-settings-dialog.tsx`
**Action**: Modify
**Changes**:
- Add local state: `const [shellAutoRestartEnabled, setShellAutoRestartEnabled] = useState(true);`
- Sync from config on open (follow the `readyForReviewNotificationsEnabled` pattern at line 405)
- Add a "Terminal" section heading after the "Notifications" section, before "Layout"
- Add a `RadixSwitch.Root` toggle for "Auto-restart shell terminals on unexpected exit"
- Include `shellAutoRestartEnabled` in the `save({...})` call

**Code Pattern to Follow**: See `readyForReviewNotificationsEnabled` toggle at `runtime-settings-dialog.tsx:656-666` — replicate the exact same structure with different label text.

**UI placement**: After the Notifications section (line 679), before the Layout section (line 681). Insert:
```
<h6 className="font-semibold text-text-primary mt-4 mb-2">Terminal</h6>
<div className="flex items-center gap-2">
   <RadixSwitch.Root ...>
      <RadixSwitch.Thumb ... />
   </RadixSwitch.Root>
   <span className="text-[13px] text-text-primary">Auto-restart shell terminals on unexpected exit</span>
</div>
<p className="text-text-secondary text-[13px] mt-1 mb-0">
   When enabled, shell terminals that crash or exit unexpectedly will automatically restart.
</p>
```

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] All tests pass: `npm run check`
- [ ] Typecheck passes: `npm run typecheck && npm run web:typecheck`

##### Behavioral

- [ ] Open settings dialog — "Terminal" section appears with toggle, default on
- [ ] Toggle off, save, close, reopen — toggle is still off (persisted)
- [ ] Check the global config file (path from `globalConfigPath` / `getRuntimeGlobalConfigPath()`) — `shellAutoRestartEnabled: false` is present

**Checkpoint**: Pause here for verification before proceeding to Phase 3.

---

### Phase 3: Auto-Restart Logic with Rate Limiting

#### Overview

Implement the core auto-restart behavior: a new `useShellAutoRestart` hook that listens for shell terminal exit events and triggers the existing restart handlers with rate limiting and crash-loop protection.

#### Changes Required

##### 1. Create the auto-restart hook

**File**: `web-ui/src/hooks/use-shell-auto-restart.ts` (NEW)
**Action**: Add

The hook encapsulates:
- **Rate limiter**: A `Map<string, number[]>` (taskId → array of restart timestamps). Max 3 restarts per 30-second window per taskId. Timestamps older than 30s are pruned on each check.
- **Exit handler callback**: `(taskId: string, exitCode: number | null) => void`
  - If `exitCode === 0`: return (clean exit, no auto-restart)
  - If setting `shellAutoRestartEnabled` is `false`: return
  - Validate `taskId` is a known restartable pattern (`HOME_TERMINAL_TASK_ID` or `__detail_terminal__:<non-empty-cardId>`). If neither matches, return (ignore the exit — this covers agent taskIds and malformed detail terminal taskIds with empty cardId).
  - If rate limit exceeded for this `taskId`: write crash-loop message to terminal, return
  - Otherwise: write restart message to terminal, schedule restart after 1000ms delay

**Interface**:
```typescript
interface UseShellAutoRestartOptions {
   shellAutoRestartEnabled: boolean;
   restartHomeTerminal: () => void;
   restartDetailTerminal: (cardId: string) => void;
   writeToTerminal: (taskId: string, message: string) => void;
   isSessionRunning: (taskId: string) => boolean;
}

interface UseShellAutoRestartResult {
   handleShellExit: (taskId: string, exitCode: number | null) => void;
   cancelPendingRestart: (taskId: string) => void;
}
```

**Key implementation details**:
- The `handleShellExit` function is the callback passed as `onExit` to the terminal subscriber. Because `notifyExit` already filters out agent sessions (see Phase 1 section 2), `handleShellExit` does not need to check `agentId` — it only fires for shell terminals.
- Use `useRef` for the rate limiter map so it persists across renders without causing re-renders
- Use `useRef` for pending restart timers so they can be cancelled on unmount
- `useEffect` cleanup must clear all pending timers
- The 1-second delay uses `setTimeout`, stored in a `Map<string, NodeJS.Timeout>` ref for cleanup. Inside the `setTimeout` callback: (1) check `isSessionRunning(taskId)` — if it returns `true`, the restart is a no-op (prevents double-restart when a manual restart completes during the 1s delay); (2) call `recordRestart(taskId)` to record the rate-limit timestamp (recording here, not at schedule time, ensures cancelled/guarded restarts don't consume rate limit slots); (3) call the restart handler
- **Cancel on manual restart**: The hook should also expose a `cancelPendingRestart(taskId: string)` function that clears any pending auto-restart timer for the given taskId. The manual restart handlers in `useTerminalPanels` (`handleRestartHomeTerminal`, `handleRestartDetailTerminal`) should call `cancelPendingRestart` before initiating the manual restart. This provides a deterministic guard — the `isSessionRunning` check is a fallback for cases where the tRPC round-trip takes longer than 1s.
- `HOME_TERMINAL_TASK_ID` (`"__home_terminal__"`) determines which restart handler to call. Any other shell taskId (matching `"__detail_terminal__:<cardId>"` pattern) extracts the `cardId` suffix (everything after the `DETAIL_TERMINAL_TASK_PREFIX`) and passes it to `restartDetailTerminal(cardId)`. If the cardId extraction fails (no prefix match), the exit is ignored. Additionally, if the extracted cardId is an empty string (e.g., taskId is exactly `"__detail_terminal__:"` with no cardId), the exit is ignored — this guards against malformed taskIds.
- **Async error safety**: The restart handlers (`handleRestartHomeTerminal`, `handleRestartDetailTerminalById`) use the `void (async () => { ... })()` fire-and-forget pattern (matching existing code at `use-terminal-panels.ts:408`). These are typed as `() => void` in the hook interface. Inside the `setTimeout` callback, the restart handler call MUST be wrapped in a `.catch()` to prevent unhandled promise rejections: `try { restartHandler(); } catch (e) { /* sync error, unlikely */ }`. Since the async work happens inside the fire-and-forget wrapper, each restart handler must also add `.catch(notifyError)` to the inner async chain (e.g., `void (async () => { ... })().catch(notifyError)`).

**Rate limiter algorithm**:
```
function canRestart(taskId: string): boolean {
   const now = Date.now();
   const timestamps = rateLimiter.get(taskId) ?? [];
   const recent = timestamps.filter(t => now - t < 30_000);
   if (recent.length >= 3) return false;
   // NOTE: Do NOT push timestamp here. The timestamp is recorded inside
   // the setTimeout callback, after the isSessionRunning guard passes and
   // before calling the restart handler. This prevents cancelled/guarded
   // restarts from consuming rate limit slots.
   return true;
}

function recordRestart(taskId: string): void {
   const now = Date.now();
   const timestamps = rateLimiter.get(taskId) ?? [];
   const recent = timestamps.filter(t => now - t < 30_000);
   recent.push(now);
   rateLimiter.set(taskId, recent);
}
```

**Terminal messages**:
- Before restart: `\r\n[quarterdeck] shell exited unexpectedly, restarting...\r\n`
- On crash loop: `\r\n[quarterdeck] shell could not be restarted automatically, click restart to try again\r\n`
- **Message ordering**: Both the exit message (`session exited with code X`, written by the exit handler) and the restart/crash-loop message (written by the auto-restart hook via `writeToTerminalBuffer`) go through the same `terminalWriteQueue` on the `PersistentTerminal` instance. The queue serializes writes, so the exit message always appears before the restart message in the terminal buffer.

##### 2. Wire the hook into the terminal panel system

**File**: `web-ui/src/hooks/use-terminal-panels.ts`
**Action**: Modify
**Changes**:
- Import and call `useShellAutoRestart` inside `useTerminalPanels`
- Add a new `handleRestartDetailTerminalById` callback that takes a `cardId: string`, looks up the card, and performs the stop+start sequence. This avoids the closure dependency on `selectedCard` that `handleRestartDetailTerminal` has (which may be stale when the auto-restart timer fires 1s later). **Card lookup mechanism**: `useTerminalPanels` does not currently have access to board state. Add an optional `findCard?: (cardId: string) => BoardCard | null` callback to `UseTerminalPanelsInput`. The caller (App.tsx) must pass a **stable, ref-based** `findCard` function to avoid stale closures. App.tsx does not currently have a `boardRef`, so add one: `const boardRef = useRef(board); boardRef.current = board;` (standard `useLatest` pattern). Then define `findCard` with `useCallback`: `const findCard = useCallback((cardId: string) => findCardSelection(boardRef.current, cardId)?.card ?? null, [])` — the empty dependency array is correct because `boardRef` is a stable ref. This ensures the function identity is stable (no re-renders from `useTerminalPanels`) while always reading the latest board state when called. Inside `handleRestartDetailTerminalById`, call `findCard(cardId)` — if it returns null, log a warning and no-op. If it returns a card, perform the stop+start via `startDetailTerminalForCard(card)`.
- Pass the required options: `shellAutoRestartEnabled` (from runtime config), `restartHomeTerminal: handleRestartHomeTerminal`, `restartDetailTerminal: handleRestartDetailTerminalById`, `writeToTerminal` and `isSessionRunning` as closures that capture `currentProjectId` as `workspaceId`:
  - `writeToTerminal: (taskId, msg) => { if (currentProjectId) writeToTerminalBuffer(currentProjectId, taskId, msg); }`
  - `isSessionRunning: (taskId) => currentProjectId ? isTerminalSessionRunning(currentProjectId, taskId) : false`
  These closures are defined inside `useTerminalPanels` which already has `currentProjectId` in scope. The `useShellAutoRestart` hook's interface only takes `(taskId, ...)` — it does not need to know about `workspaceId`.
- Expose `handleShellExit` and `cancelPendingRestart` from the hook's return value in `UseTerminalPanelsResult`
- The manual restart handlers (`handleRestartHomeTerminal`, `handleRestartDetailTerminal`) should call `cancelPendingRestart(taskId)` at the start to cancel any pending auto-restart timer before initiating the manual restart. For `handleRestartHomeTerminal`, pass `HOME_TERMINAL_TASK_ID`. For `handleRestartDetailTerminal`, pass `getDetailTerminalTaskId(card.id)` (the composed taskId, not the raw `card.id`) — this must match the taskId used by the auto-restart timer map.

##### 3. Connect exit events to the auto-restart hook

Shell terminals are mounted via `AgentTerminalPanel` (which internally calls `usePersistentTerminalSession`) in two locations:

1. **Home shell terminal**: `web-ui/src/App.tsx` around line 997 — `<AgentTerminalPanel key={`home-shell-...`} taskId={homeTerminalTaskId} ...>`
2. **Detail shell terminal**: `web-ui/src/components/card-detail-view.tsx` around line 931 — `<AgentTerminalPanel key={`detail-shell-...`} taskId={bottomTerminalTaskId} ...>`

Both mount `AgentTerminalPanel`, which calls `usePersistentTerminalSession` internally. The `onExit` callback needs to flow from the hook (Phase 1, section 3) through `AgentTerminalPanel` props down to `usePersistentTerminalSession`.

**File**: `web-ui/src/components/detail-panels/agent-terminal-panel.tsx`
**Action**: Modify
**Changes**:
- Add `onExit?: (taskId: string, exitCode: number | null) => void` to `AgentTerminalPanelProps`
- Pass it through to `usePersistentTerminalSession({ ..., onExit })`

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Changes**:
- Pass `handleShellExit` as `onExit` prop to the home shell `AgentTerminalPanel` (the one with `key={`home-shell-...`}`)

**File**: `web-ui/src/components/card-detail-view.tsx`
**Action**: Modify
**Changes**:
- Add `onBottomTerminalExit?: (taskId: string, exitCode: number | null) => void` to `CardDetailView`'s inline props (after `onBottomTerminalRestart`, line 326)
- Pass it through to the detail shell `AgentTerminalPanel` as `onExit={onBottomTerminalExit}` (the one with `key={`detail-shell-...`}` at line 931)

**File**: `web-ui/src/App.tsx`
**Action**: Modify (CardDetailView mount at line 1026)
**Changes**:
- Pass `onBottomTerminalExit={handleShellExit}` to the `<CardDetailView>` mount, where `handleShellExit` comes from `useTerminalPanels` return value. This threads the callback through the existing prop-passing pattern alongside `onBottomTerminalRestart={handleRestartDetailTerminal}`.

**Agent filtering**: Shell-only filtering is handled inside the `notifyExit` method on `PersistentTerminal` (see section below), NOT at each call site. This avoids leaking agent-filtering logic to every consumer.

##### 4. Provide `writeToTerminalBuffer` and `isTerminalSessionRunning` exports

**File**: `web-ui/src/terminal/persistent-terminal-manager.ts`
**Action**: Modify
**Changes**:
- Add a public `writeText(text: string): void` method on the `PersistentTerminal` class that checks `if (this.disposed) return;` before calling `this.enqueueTerminalWrite(text)`. The disposed guard is necessary because `enqueueTerminalWrite` chains onto `terminalWriteQueue` via `.then()` — while the inner `Promise` callback already checks `this.disposed`, the outer chain still executes and the `this.terminal.write()` call inside the resolved promise would operate on a disposed xterm instance. The early return avoids enqueuing work on a dead terminal entirely.
- Add an exported module-level function `writeToTerminalBuffer(workspaceId: string, taskId: string, text: string): void` that looks up the terminal in the module-level `terminals` map (line 775) via `buildKey(workspaceId, taskId)` and calls `terminal.writeText(text)`. If no terminal is found, it is a silent no-op.
- Add an exported module-level function `isTerminalSessionRunning(workspaceId: string, taskId: string): boolean` that looks up the terminal in the `terminals` map and returns `terminal.latestSummary?.state === "running"`. Requires making `latestSummary` accessible — either add a public getter `get sessionState(): string | null` that returns `this.latestSummary?.state ?? null`, or make `latestSummary` a public readonly field.

**Rationale**: The module uses a module-level `Map<string, PersistentTerminal>` (not a class-based manager). `enqueueTerminalWrite` is private on `PersistentTerminal`, so a public wrapper is needed. The `writeToTerminalBuffer` function follows the same pattern as existing exports (`ensurePersistentTerminal`, `disposePersistentTerminal`) that look up terminals by key.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] All tests pass: `npm run check`
- [ ] Web UI tests pass: `npm run web:test`

##### Behavioral

- [ ] Open home terminal, run `exit 1` → see `[quarterdeck] shell exited unexpectedly, restarting...`, terminal restarts after ~1s
- [ ] Open home terminal, run `exit 0` → see `[quarterdeck] session exited with code 0`, terminal does NOT restart
- [ ] Open home terminal, rapidly run `exit 1` four times → fourth time shows `[quarterdeck] shell could not be restarted automatically, click restart to try again` and does NOT restart
- [ ] Disable auto-restart in settings, open home terminal, run `exit 1` → terminal does NOT restart
- [ ] Open detail terminal on a card, run `exit 1` → detail terminal auto-restarts
- [ ] Start an agent session, let it exit → agent terminal behavior is completely unchanged

**Checkpoint**: Verify all behavioral criteria before considering the feature complete.

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| Restart handler throws (tRPC call fails) | Error is caught, terminal shows the error via existing `notifyError` path. The rate limiter timestamp was recorded just before the restart call, so the failed attempt counts toward the limit. In pathological cases (e.g., runtime server down), the rate limiter may exhaust after 3 failed tRPC attempts and show the "shell could not be restarted automatically" message. This is acceptable UX: the user sees the message, clicks the manual restart button (which is not gated by the rate limiter), and can retry when the server recovers. | Kill the runtime server, trigger a shell exit — error toast appears, terminal stays dead |
| Cancelled restart during 1s delay | If `cancelPendingRestart` clears the timer or `isSessionRunning` returns true when the timer fires, the restart is skipped and no rate limit timestamp is recorded (timestamp recording happens inside the setTimeout callback, after the guards). | Trigger exit, manually restart during the 1s delay — rate limiter is unaffected |
| Timer fires after component unmounts | `useEffect` cleanup clears all pending timers. No-op. | Navigate away from project while a restart is pending — no console errors |
| Project switch during 1s restart delay | Accepted edge case. Switching projects unmounts the component tree, triggering `useEffect` cleanup which clears all pending timers. The restart does not fire. | Switch projects while `restarting...` message is visible — no restart fires, no errors |
| Setting changes while restart is pending | The pending restart still fires (timer was already set). Future exits use the new setting value. | Toggle setting off while `restarting...` message is visible — this restart completes, next exit does not restart |
| Rate limiter map grows unbounded | Timestamps older than 30s are pruned on every `canRestart` call. Entries for closed terminals remain but are tiny (a few timestamps). No cleanup needed for normal usage. | Not a practical concern for the number of terminals a user opens |

## Rollback Strategy

- **Phase 1 rollback**: Remove `onExit` from subscriber interface and exit handler. No state changes.
- **Phase 2 rollback**: Remove `shellAutoRestartEnabled` from config shapes, Zod schemas, response builder, and settings dialog. Remove from any persisted `config.json` files (or leave — unknown keys are ignored).
- **Phase 3 rollback**: Delete `use-shell-auto-restart.ts`, remove wiring from `use-terminal-panels.ts`, `App.tsx`, `card-detail-view.tsx`, and `agent-terminal-panel.tsx`. Remove `writeToTerminalBuffer`, `isTerminalSessionRunning`, and `writeText` from `persistent-terminal-manager.ts`.
- **Full rollback**: Revert all three phases. The feature is entirely additive with no breaking changes to existing behavior.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Shell exits 0 unexpectedly (shell profile error that exits cleanly) | Low | Low — no restart, user clicks button | Acceptable; exit code 0 = clean exit is the correct heuristic |
| `writeToTerminal` bridge is fragile if terminal manager internals change | Low | Med — auto-restart messages stop appearing | Terminal still restarts, just without the user-facing message |
| Settings dialog section ordering changes in a concurrent PR | Low | Low — merge conflict | Straightforward resolution |

## Implementation Notes / Gotchas

- **`stopTaskSession` and exit events — double-restart prevention**: When the user clicks the existing restart button, `handleRestartHomeTerminal` calls `stopTaskSession` first, which kills the PTY. This kill fires an exit event. But the restart button immediately calls `startHomeTerminalSession` after the stop, so the exit event arrives to a terminal that's about to be restarted anyway. The auto-restart hook MUST NOT double-restart in this case. **Committed approach**: The auto-restart timer callback (which fires 1000ms after the exit event) MUST check if the terminal session is already in `running` state before calling the restart handler. If running, it is a no-op. This works because the manual restart handler calls stop+start in the same async chain, and the 1s delay gives ample time for the manual restart to complete. Implementation: call `isSessionRunning(taskId)` (passed via `UseShellAutoRestartOptions`) inside the `setTimeout` callback, before invoking the restart handler. `isSessionRunning` calls `isTerminalSessionRunning(workspaceId, taskId)` from `persistent-terminal-manager.ts`, which checks `latestSummary?.state === "running"` on the `PersistentTerminal` instance.
- **`enqueueTerminalWrite` accessibility**: This is a method on the `PersistentTerminal` class instance. Access to write to a specific terminal by taskId requires either: (a) the terminal manager exposes a `writeToTerminal(taskId, text)` method, or (b) the hook has a ref to the terminal instance. Check how existing code writes to terminals from outside the manager.
- **`agentId` availability**: The `latestSummary` on `PersistentTerminal` is set via `notifySummary`. Ensure the first summary (with `agentId`) arrives before the exit event. In practice, the `"state"` message with the initial summary is sent before the session can exit, so `latestSummary.agentId` is reliable.
- **Biome formatting**: This codebase uses Biome with tabs, indent width 3, line width 120. Run `npm run format` after changes.

## References

- **Related files**: `web-ui/src/terminal/persistent-terminal-manager.ts:513-516`, `web-ui/src/hooks/use-terminal-panels.ts:404-426`, `src/config/runtime-config.ts:14-49`, `web-ui/src/components/runtime-settings-dialog.tsx:656-666`
- **Prior art**: Backend agent auto-restart at `src/terminal/session-manager.ts:1077-1132`
- **Test Spec**: [docs/specs/2026-04-07-shell-terminal-auto-restart-tests.md](./2026-04-07-shell-terminal-auto-restart-tests.md)
