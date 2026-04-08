# Test Specification: Configurable Audible Notifications

**Date**: 2026-04-07
**Companion SDD**: [2026-04-07-audible-notifications.md](2026-04-07-audible-notifications.md)
**Ticket**: #14
**Adversarial Review Passes**: 2

## Test Strategy

The audible notification feature spans two domains: a pure utility layer (audio player, config persistence) and a React hook layer (event detection, settings UI). Testing follows the existing project patterns — Vitest with jsdom for web-ui, Vitest with node for runtime, and the `createRoot` + `act()` + `HookHarness` pattern for hook tests.

The Web Audio API is not available in jsdom, so all audio playback is mocked at the module level. Tests verify that the correct sounds are triggered under the right conditions with the right parameters — not that the browser actually produces audio.

**Mock session objects**: Test session objects use minimal data (only the fields relevant to each test). To satisfy TypeScript's `RuntimeTaskSessionSummary` type, either use `as RuntimeTaskSessionSummary` type assertions on minimal objects, or create a `createMockSession(overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary` factory helper that provides sensible defaults for all required fields and merges overrides. The factory approach is preferred for readability and avoids scattering type assertions across every test.

### Test Infrastructure

- **Framework**: Vitest 4.1.0
- **Test directories**: `web-ui/src/` (co-located), `test/runtime/` (runtime unit tests)
- **Run commands**:
  - All web-ui tests: `npm run web:test`
  - Runtime tests: `npm run test`
  - Specific file: `npx vitest run web-ui/src/hooks/use-audible-notifications.test.tsx`
- **CI integration**: Runs via `test.yml` workflow (Ubuntu + macOS, Node 20 + 22)

### Coverage Goals

- Every SDD requirement has at least one test
- Every error scenario from the SDD error handling table has a test
- Every per-event-type toggle has a test verifying it gates playback
- Session state transition detection covers all 4 event types + edge cases
- Settings persistence round-trips correctly

## Unit Tests

### Audio Playback Utility

**Test file**: `web-ui/src/utils/notification-audio.test.ts`
**Pattern to follow**: See `web-ui/src/utils/session-status.test.ts` for utility test conventions (if exists), or plain `describe`/`it`/`expect`.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `creates AudioContext lazily on ensureContext` | AudioContext is not created until `ensureContext()` is called |
| 2 | `resumes suspended AudioContext` | Calls `context.resume()` when state is `"suspended"` |
| 3 | `preloadSounds fetches and decodes all 4 sound files` | Fetches correct URLs and calls `decodeAudioData` for each |
| 4 | `preloadSounds silently handles fetch failure` | Does not throw when a sound file 404s |
| 5 | `preloadSounds silently handles decode failure` | Does not throw when `decodeAudioData` rejects |
| 6 | `play creates BufferSource and GainNode with correct volume` | Verifies node chain: source → gain → destination |
| 7 | `play no-ops when buffer is not loaded` | No error, no nodes created for unloaded event type |
| 8 | `play no-ops when AudioContext is null` | No error when called before any user gesture |
| 9 | `play clamps volume to 0-1 range` | Volume of 1.5 treated as 1.0, -0.5 treated as 0.0 |
| 10 | `dispose closes AudioContext and clears buffers` | Context closed, subsequent play no-ops |
| 11 | `preloadSounds skips already-loaded buffers on second call` | Calling `preloadSounds()` twice only fetches and decodes each sound file once |

#### Test Details

##### 1. `creates AudioContext lazily on ensureContext`

**Setup**: Mock `window.AudioContext` constructor. Create a fresh `NotificationAudioPlayer` instance.
**Key test data**:
- Before call: `AudioContext` constructor not called
- After `ensureContext()`: constructor called once

**Action**: Call `ensureContext()`
**Assertions**:
- `AudioContext` constructor called exactly once
- Returned context is the mocked instance
- Second call to `ensureContext()` does NOT create a new context (returns cached)

##### 2. `resumes suspended AudioContext`

**Setup**: Mock `AudioContext` that returns `state: "suspended"` and a mock `resume()` method.
**Action**: Call `ensureContext()`
**Assertions**:
- `context.resume()` was called

##### 3. `preloadSounds fetches and decodes all 4 sound files`

**Setup**: Mock `fetch` to return `Response` with `arrayBuffer()`. Mock `audioContext.decodeAudioData` to return mock `AudioBuffer`.
**Key test data**:
- Expected fetch URLs: `"/assets/sounds/permission.mp3"`, `"/assets/sounds/review.mp3"`, `"/assets/sounds/failure.mp3"`, `"/assets/sounds/completion.mp3"`

**Action**: Call `ensureContext()` then `preloadSounds()`
**Assertions**:
- `fetch` called 4 times with the correct URLs
- `decodeAudioData` called 4 times
- After preload, all 4 event types have cached buffers (verified by subsequent `play()` calls creating nodes)

##### 6. `play creates BufferSource and GainNode with correct volume`

**Setup**: Preloaded player with mocked AudioContext, mocked `createBufferSource()`, `createGain()`, and `destination`.
**Key test data**:
- Event type: `"permission"`
- Volume: `0.5`

**Action**: Call `play("permission", 0.5)`
**Assertions**:
- `createBufferSource()` called once
- `createGain()` called once
- `gainNode.gain.value` set to `0.5`
- Source `buffer` set to the preloaded permission AudioBuffer
- Source connected to gain node
- Gain node connected to `audioContext.destination`
- `source.start()` called

##### 11. `preloadSounds skips already-loaded buffers on second call`

**Setup**: Mock `fetch` and `audioContext.decodeAudioData` as in test 3.
**Action**: Call `preloadSounds()` twice.
**Assertions**:
- `fetch` called exactly 4 times total (not 8) — second `preloadSounds()` call skips all already-loaded buffers
- `decodeAudioData` called exactly 4 times total

### Audible Notification Hook

**Test file**: `web-ui/src/hooks/use-audible-notifications.test.tsx`
**Pattern to follow**: See `web-ui/src/hooks/use-review-ready-notifications.test.tsx` for the `createRoot` + `act()` + `HookHarness` pattern and mock setup.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `plays permission sound when task is waiting for approval` | Permission event type detected from `latestTaskReadyForReview` + real `isApprovalState()` (no mock — uses real logic from `@/utils/session-status.ts`) |
| 2 | `plays review sound when task is ready for review (non-permission)` | Review event type detected when not an approval state |
| 3 | `plays failure sound when session transitions to error` | Failure detected from session state diff |
| 4 | `plays completion sound when session exits successfully` | Completion detected from session state diff (exit code 0) |
| 5 | `does not play when master toggle is disabled` | Global toggle gates all sounds |
| 6 | `does not play permission sound when permission event is disabled` | Per-event toggle gates individually |
| 7 | `does not play review sound when review event is disabled` | Per-event toggle gates individually |
| 8 | `does not play failure sound when failure event is disabled` | Per-event toggle gates individually |
| 9 | `does not play completion sound when completion event is disabled` | Per-event toggle gates individually |
| 10 | `does not play when tab is visible and focused` | Hook reads `document.visibilityState` and `document.hasFocus()` directly; when both indicate visible+focused → skip sound |
| 11 | `does not play for initial snapshot load` | First render populates state ref without triggering audio |
| 12 | `deduplicates review-ready events` | Same event key does not trigger sound twice |
| 13 | `passes volume to audio player` | Volume from settings flows through to `play()` call |
| 14 | `handles batch session updates` | Multiple sessions changing in one `taskSessions` update |
| 15 | `skips events from different workspace` | Workspace ID mismatch filters out events |
| 16 | `plays failure sound when session exits with non-zero exit code` | `reviewReason === "exit"` + `exitCode !== 0` → failure sound |
| 17 | `plays failure sound when session exits with null exit code` | `reviewReason === "exit"` + `exitCode === null` → failure sound |
| 18 | `plays failure sound when session transitions to failed state` | `state === "failed"` (direct PTY crash) → failure sound |
| 19 | `does not play when session is interrupted` | `state === "interrupted"` → no sound (user-initiated) |
| 20 | `does not play when review reason is interrupted` | `state === "awaiting_review"` + `reviewReason === "interrupted"` → no sound |
| 21 | `plays review sound when review reason is attention` | `state === "awaiting_review"` + `reviewReason === "attention"` → review sound |
| 22 | `clears previous session state ref on workspace switch` | Changing `activeWorkspaceId` resets state tracking, no spurious sounds |
| 23 | `registers one-time click listener that unlocks AudioContext` | On mount, adds a `click` event listener to `document` that calls `ensureContext()` and `preloadSounds()`, then removes itself after first invocation |
| 24 | `skips all sound playback when activeWorkspaceId is null` | No sounds play when there is no active workspace, even if events are present |

#### Test Details

##### 1. `plays permission sound when task is waiting for approval`

**Setup**:
- Mock `notificationAudioPlayer.play` via `vi.mock("@/utils/notification-audio")`
- Do NOT mock `isApprovalState` — use the real implementation from `@/utils/session-status.ts`. The hook depends on it and tests should validate the integration. The real `isApprovalState()` checks: `state === "awaiting_review" && reviewReason === "hook" && isPermissionRequest(summary)`, where `isPermissionRequest` checks `hookEventName`, `notificationType`, and `activityText`.
- Mock `document.visibilityState` as `"hidden"` and `document.hasFocus()` as `false`
- Create `HookHarness` component rendering `useAudibleNotifications`
- Initial props: enabled, all events on, volume 0.7

**Key test data**:
- `latestTaskReadyForReview`: `{ type: "task_ready_for_review", workspaceId: "ws-1", taskId: "task-1", triggeredAt: 1000 }`
- `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "hook", latestHookActivity: { hookEventName: "PermissionRequest", notificationType: "permission.asked" } } }`

**Action**: Render with initial props (no event), then re-render with `latestTaskReadyForReview` set
**Assertions**:
- `notificationAudioPlayer.play` called with `("permission", 0.7)`

##### 3. `plays failure sound when session transitions to error`

**Setup**: Same as above, but no `latestTaskReadyForReview`.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "error" } }`

**Action**: Render with running session, then re-render with error session
**Assertions**:
- `notificationAudioPlayer.play` called with `("failure", 0.7)`

##### 4. `plays completion sound when session exits successfully`

**Setup**: Same as above.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "exit", exitCode: 0 } }`

**Action**: Render with running session, then re-render with completed session
**Assertions**:
- `notificationAudioPlayer.play` called with `("completion", 0.7)`

##### 11. `does not play for initial snapshot load`

**Setup**: Same as above.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "error" } }` (already in error state on first render)

**Action**: Render with error session as initial state (simulating snapshot load)
**Assertions**:
- `notificationAudioPlayer.play` NOT called — the hook populated its previous-state ref without triggering

##### 14. `handles batch session updates`

**Setup**: Same as above.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running" }, "task-2": { state: "running" } }`
- Updated `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "exit", exitCode: 0 }, "task-2": { state: "awaiting_review", reviewReason: "error" } }`

**Action**: Re-render with both sessions changed
**Assertions**:
- `notificationAudioPlayer.play` called twice: once with `"completion"` and once with `"failure"`

##### 16. `plays failure sound when session exits with non-zero exit code`

**Setup**: Same as test 3.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "exit", exitCode: 1 } }`

**Action**: Render with running session, then re-render with exit code 1
**Assertions**:
- `notificationAudioPlayer.play` called with `("failure", 0.7)`

##### 17. `plays failure sound when session exits with null exit code`

**Setup**: Same as test 3.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "exit", exitCode: null } }`

**Action**: Render with running session, then re-render with null exit code
**Assertions**:
- `notificationAudioPlayer.play` called with `("failure", 0.7)`

##### 18. `plays failure sound when session transitions to failed state`

**Setup**: Same as test 3.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "failed", reviewReason: null } }`

**Action**: Render with running session, then re-render with failed state
**Assertions**:
- `notificationAudioPlayer.play` called with `("failure", 0.7)`

##### 19. `does not play when session is interrupted`

**Setup**: Same as test 3.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "interrupted", reviewReason: null } }`

**Action**: Render with running session, then re-render with interrupted state
**Assertions**:
- `notificationAudioPlayer.play` NOT called

##### 20. `does not play when review reason is interrupted`

**Setup**: Same as test 3.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "interrupted" } }`

**Action**: Render with running session, then re-render with interrupted review reason
**Assertions**:
- `notificationAudioPlayer.play` NOT called

##### 21. `plays review sound when review reason is attention`

**Setup**: Same as test 3.
**Key test data**:
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "attention" } }`

**Action**: Render with running session, then re-render with attention review reason
**Assertions**:
- `notificationAudioPlayer.play` called with `("review", 0.7)`

##### 22. `clears previous session state ref on workspace switch`

**Setup**: Same as test 3.
**Key test data**:
- Initial props: `activeWorkspaceId: "ws-1"`, `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Step 1: Re-render with `activeWorkspaceId: "ws-2"`, `taskSessions`: `{ "task-2": { state: "awaiting_review", reviewReason: "error" } }`
  The error session in ws-2 should be treated as an initial snapshot (ref was cleared), not as a transition.

**Action**: Render with ws-1, then switch to ws-2 with an error session already present
**Assertions**:
- `notificationAudioPlayer.play` NOT called — the workspace switch cleared the ref, so the error session is treated as initial state

##### 23. `registers one-time click listener that unlocks AudioContext`

**Setup**: Spy on `document.addEventListener` and `document.removeEventListener`. Mock `notificationAudioPlayer.ensureContext` and `notificationAudioPlayer.preloadSounds`.
**Action**: Render hook. Verify a `click` listener was registered on `document`. Simulate a click event on `document`.
**Assertions**:
- `document.addEventListener` called with `"click"` and a handler
- After simulated click: `notificationAudioPlayer.ensureContext` called once
- After simulated click: `notificationAudioPlayer.preloadSounds` called once
- `document.removeEventListener` called with `"click"` and the same handler (one-time behavior)
- A second simulated click does NOT call `ensureContext` again

##### 24. `skips all sound playback when activeWorkspaceId is null`

**Setup**: Same as test 3, but `activeWorkspaceId: null`.
**Key test data**:
- `activeWorkspaceId`: `null`
- `latestTaskReadyForReview`: `{ type: "task_ready_for_review", workspaceId: "ws-1", taskId: "task-1", triggeredAt: 1000 }`
- Initial `taskSessions`: `{ "task-1": { state: "running", reviewReason: null } }`
- Updated `taskSessions`: `{ "task-1": { state: "awaiting_review", reviewReason: "error" } }`

**Action**: Render with null workspace and trigger events
**Assertions**:
- `notificationAudioPlayer.play` NOT called — null workspace skips all playback

### Settings Dialog — Audible Notification Controls

**Test file**: `web-ui/src/components/runtime-settings-dialog.test.tsx` (extend existing)
**Pattern to follow**: See existing tests in the same file for dialog rendering and config mock patterns.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `renders audible notification controls when dialog is open` | Master toggle, volume slider, 4 event checkboxes, test button all render |
| 2 | `disables per-event controls when master toggle is off` | Volume slider and checkboxes have disabled state |
| 3 | `includes audible settings in save payload` | Save mutation receives the new config fields |
| 4 | `syncs audible settings from loaded config` | Opening dialog populates controls from server state |

### Runtime Config Persistence

**Test file**: `test/runtime/config/runtime-config.test.ts` (extend existing)
**Pattern to follow**: See existing tests in the same file for temp dir setup and config read/write patterns.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `loads default audible notification settings when config is empty` | Fresh config returns `audibleNotificationsEnabled: true`, volume 0.7, all events true |
| 2 | `persists audible notification settings to config file` | Write then read round-trips correctly |
| 3 | `merges partial audible notification events with defaults` | Config with only `{ permission: false }` returns other events as `true` |
| 4 | `handles missing audible fields in existing config gracefully` | Old config file without the new fields loads with defaults (backwards compatibility) |

#### Test Details

##### 3. `merges partial audible notification events with defaults`

**Setup**: Create temp config dir, write config file with:
```json
{ "audibleNotificationEvents": { "permission": false } }
```

**Action**: Load config using the same config-loading approach used in existing tests in `test/runtime/config/runtime-config.test.ts`
**Assertions**:
- `config.audibleNotificationEvents.permission` === `false`
- `config.audibleNotificationEvents.review` === `true`
- `config.audibleNotificationEvents.failure` === `true`
- `config.audibleNotificationEvents.completion` === `true`

##### 4. `handles missing audible fields in existing config gracefully`

**Setup**: Create temp config dir, write config file with only `{ "selectedAgentId": "claude" }` (pre-existing config without audible fields).

**Action**: Load config using the same config-loading approach used in existing tests in `test/runtime/config/runtime-config.test.ts`
**Assertions**:
- `config.audibleNotificationsEnabled` === `true`
- `config.audibleNotificationVolume` === `0.7`
- `config.audibleNotificationEvents` deep-equals `{ permission: true, review: true, failure: true, completion: true }`

## Edge Cases & Error Scenarios

These tests were identified during the spec authoring process and will be refined during adversarial review.

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 1 | `handles AudioContext constructor throwing` | Browser disallows AudioContext creation | `ensureContext()` returns null, `play()` no-ops, no errors thrown | Error handling table |
| 2 | `handles rapid sequential play calls` | 3 sounds triggered within 100ms | All 3 play (no debounce/throttle in v1) | Risk: rapid-fire sounds |
| 3 | `handles session removed from taskSessions` | A task ID disappears from the sessions map between renders | No crash, no sound (treat as cleanup) | Session state diffing gotcha |
| 4 | `handles workspace switch` | `activeWorkspaceId` changes between renders | Previous session state ref is cleared; new workspace's existing sessions are treated as initial snapshot (no sounds). See hook test 22 for detailed test. | Implementation note |
| 5 | `volume 0 still calls play` | Master enabled, volume set to 0 | `play()` IS called with volume 0 (gain node at 0 effectively mutes — no special case) | Design decision resolved |

## Regression Tests

Tests that ensure existing behavior isn't broken by the new implementation.

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 1 | `browser notifications still fire independently of audio` | Existing `useReviewReadyNotifications` hook behavior is unchanged | `web-ui/src/hooks/use-review-ready-notifications.ts:75` |
| 2 | `existing config fields preserved after adding audio settings` | Adding new fields doesn't clear or corrupt existing config | `src/config/runtime-config.ts:493` |
| 3 | `settings dialog save still works for non-audio settings` | The existing save flow isn't broken by new fields | `web-ui/src/components/runtime-settings-dialog.tsx:496` |

## Test Execution Plan

Tests should be written BEFORE the implementation code they validate. This is a per-phase TDD sequence.

### Phase 1: Audio Engine & Sound Files

1. **Write unit tests** — define audio player behavior
   - Write: all tests in `notification-audio.test.ts` (tests 1-11)
   - Run: `npx vitest run web-ui/src/utils/notification-audio.test.ts` — all FAIL (file doesn't exist yet)
2. **Implement Phase 1** — create audio player utility and sound files
   - Run: `npx vitest run web-ui/src/utils/notification-audio.test.ts` — all pass
3. **Verify sound files** — manual check that URLs resolve

### Phase 2: Settings Infrastructure

1. **Write regression tests** — verify existing config behavior
   - Write: regression tests 2-3 in `runtime-config.test.ts`
   - Run: `npm run test -- --grep "runtime-config"` — all pass (baseline)
2. **Write unit tests** — define new config behavior
   - Write: config tests 1-4 in `runtime-config.test.ts`
   - Run: `npm run test -- --grep "runtime-config"` — new tests FAIL
3. **Implement Phase 2** — add config fields through the chain
   - Run: `npm run test` — all pass

### Phase 3: Settings UI

1. **Write unit tests** — define settings dialog behavior
   - Write: settings dialog tests 1-4 in `runtime-settings-dialog.test.tsx`
   - Run: `npx vitest run web-ui/src/components/runtime-settings-dialog.test.tsx` — new tests FAIL
2. **Implement Phase 3** — add UI controls
   - Run: `npm run web:test` — all pass

### Phase 4: Notification Hook

1. **Write unit tests** — define hook behavior
   - Write: all tests in `use-audible-notifications.test.tsx` (tests 1-24)
   - Write: edge case tests 1-5
   - Run: `npx vitest run web-ui/src/hooks/use-audible-notifications.test.tsx` — all FAIL
2. **Implement Phase 4** — create hook and wire in App.tsx
   - Run: `npm run web:test` — all pass
3. **Run full test suite**
   - Run: `npm run check` — all pass

### Commands

```bash
# Run all tests for this feature
npm run test && npm run web:test

# Run audio player utility tests only
npx vitest run web-ui/src/utils/notification-audio.test.ts

# Run hook tests only
npx vitest run web-ui/src/hooks/use-audible-notifications.test.tsx

# Run settings dialog tests only
npx vitest run web-ui/src/components/runtime-settings-dialog.test.tsx

# Run runtime config tests only
npx vitest run test/runtime/config/runtime-config.test.ts

# Run with verbose output for debugging
npx vitest run --reporter=verbose web-ui/src/hooks/use-audible-notifications.test.tsx
```

## Traceability Matrix

Every SDD requirement maps to at least one test. This is the single source of truth for requirement-to-test mapping.

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Permission sound plays on approval state | Hook test 1 | Unit |
| Review sound plays on non-permission review | Hook test 2 | Unit |
| Failure sound plays on session error | Hook test 3 | Unit |
| Completion sound plays on successful exit | Hook test 4 | Unit |
| Global master toggle gates all sounds | Hook test 5 | Unit |
| Per-event permission toggle | Hook test 6 | Unit |
| Per-event review toggle | Hook test 7 | Unit |
| Per-event failure toggle | Hook test 8 | Unit |
| Per-event completion toggle | Hook test 9 | Unit |
| Tab visibility prevents sounds when visible+focused | Hook test 10 | Unit |
| Initial snapshot does not trigger sounds | Hook test 11 | Edge case |
| Event deduplication | Hook test 12 | Unit |
| Volume flows to audio player | Hook test 13 | Unit |
| Batch session updates handled | Hook test 14 | Edge case |
| Workspace filtering | Hook test 15 | Unit |
| Failure on non-zero exit code | Hook test 16 | Unit |
| Failure on null exit code | Hook test 17 | Unit |
| Failure on `state: "failed"` (PTY crash) | Hook test 18 | Unit |
| No sound on `state: "interrupted"` | Hook test 19 | Unit |
| No sound on `reviewReason: "interrupted"` | Hook test 20 | Unit |
| Review sound on `reviewReason: "attention"` | Hook test 21 | Unit |
| Workspace switch clears session state ref | Hook test 22 | Edge case |
| AudioContext unlock via user-gesture click listener | Hook test 23 | Unit |
| Null `activeWorkspaceId` skips all playback | Hook test 24 | Edge case |
| AudioContext lazy creation | Audio test 1 | Unit |
| AudioContext resume on suspended | Audio test 2 | Unit |
| Sound preloading | Audio test 3 | Unit |
| Fetch failure resilience | Audio test 4 | Edge case |
| Decode failure resilience | Audio test 5 | Edge case |
| Correct audio node chain | Audio test 6 | Unit |
| Missing buffer no-op | Audio test 7 | Edge case |
| Null context no-op | Audio test 8 | Edge case |
| Volume clamping | Audio test 9 | Edge case |
| Dispose cleanup | Audio test 10 | Unit |
| Preload idempotency (skip loaded buffers) | Audio test 11 | Unit |
| Settings UI renders controls | Dialog test 1 | Unit |
| Controls disabled when master off | Dialog test 2 | Unit |
| Save payload includes audio settings | Dialog test 3 | Unit |
| Dialog syncs from loaded config | Dialog test 4 | Unit |
| Default config values | Config test 1 | Unit |
| Config round-trip persistence | Config test 2 | Unit |
| Partial event object merge | Config test 3 | Edge case |
| Backwards-compatible config loading | Config test 4 | Regression |
| Browser notifications unchanged | Regression test 1 | Regression |
| Existing config fields preserved | Regression test 2 | Regression |
| Settings save unbroken | Regression test 3 | Regression |
| Volume 0 still calls play (no special case) | Edge case test 5 | Edge case |
