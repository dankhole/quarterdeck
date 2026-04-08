# Configurable Audible Notifications — Implementation Specification

**Date**: 2026-04-07
**Branch**: main
**Ticket**: #14
**Adversarial Review Passes**: 2
**Test Spec**: [2026-04-07-audible-notifications-tests.md](2026-04-07-audible-notifications-tests.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
#14 Audible notifications — Play sounds via Web Audio API when tasks need attention (permissions, review, failure, completion). Global on/off toggle, per-event-type enable/disable, volume or sound selection. Optional system-level audio via afplay/paplay for background use.
-->

## Goal

Add audible notifications to the Quarterdeck web UI so users hear distinct sounds when tasks need attention — waiting for permissions, moved to review, session failure, and task completion. This eliminates the need to visually monitor the board while agents work. Sounds are configurable per event type with a global toggle and volume control, using bundled audio files played via the Web Audio API.

## Current State

- `web-ui/src/hooks/use-review-ready-notifications.ts:75-209` — Existing hook handles browser Notification API (OS-level visual notifications) for the `task_ready_for_review` WebSocket event. Already differentiates permissions vs review via `isApprovalState()`. Already handles deduplication, tab visibility, and focus detection. **No audio is played.**
- `web-ui/src/utils/session-status.ts:5-78` — Session state classification functions: `isApprovalState()` detects permission requests, `describeSessionState()` maps review reasons to display text (exit→"Completed", error→"Error", hook→"Ready for review"/"Waiting for approval").
- `src/core/api-contract.ts:369-377` — `task_ready_for_review` WebSocket message schema. This is the only dedicated notification event. Failure and completion are detected via `task_sessions_updated` session summary state changes.
- `src/core/api-contract.ts:394-404` — `runtimeStateStreamMessageSchema` discriminated union of all WS message types.
- `web-ui/src/runtime/use-runtime-state-stream.ts:49-69` — Stream result interface exposes `latestTaskReadyForReview` and session data to consumer hooks.
- `src/config/runtime-config.ts:14-49` — Global config persistence: `RuntimeGlobalConfigFileShape` → `RuntimeConfigState` → `RuntimeConfigUpdateInput`. Settings saved to `~/.quarterdeck/config.json`.
- `web-ui/src/components/runtime-settings-dialog.tsx:656-679` — Existing "Notifications" section with a single toggle for review-ready browser notifications and permission request UI.
- `web-ui/public/assets/` — Static assets directory served at `/assets/`. Contains notification icon but no audio files.

## Desired End State

- **4 distinct notification sounds** play in the browser when tasks need attention:
  - **Permissions** — task is waiting for user approval (highest priority, most urgent sound)
  - **Review** — task moved to review via hook (non-permission)
  - **Failure** — agent session exited with error or non-zero exit code
  - **Completion** — agent session exited successfully (exit code 0)
- **Global master toggle** enables/disables all audible notifications
- **Per-event toggles** allow enabling/disabling each of the 4 event types independently
- **Volume slider** controls playback volume (0.0–1.0) for all sounds
- **Settings persist** in `~/.quarterdeck/config.json` alongside existing config
- **Sounds respect tab visibility** — only play when the tab is not actively visible and focused. Specifically: skip sound if `document.visibilityState === "visible"` AND `document.hasFocus()` are both true. Unlike the existing browser notification hook, the cross-tab presence check (`hasVisibleQuarterdeckTabForWorkspace`) is deliberately omitted for v1 — audio notifications are less intrusive than OS-level browser notifications, and the cross-tab coordination system adds complexity that isn't justified for sound alerts
- **Sounds respect browser autoplay policy** — AudioContext is created/resumed on first user interaction
- **Bundled audio files** (`.mp3`) in `web-ui/public/assets/sounds/` — 4 files, ~50-100KB total

## Out of Scope

- **System-level audio** (`afplay`/`paplay`) — deferred to a follow-up feature
- **Per-project notification settings** — global only for v1
- **Custom sound files** — users cannot provide their own sounds
- **Sound theme selection** — one built-in sound per event type, no alternatives
- **Notification grouping/throttling** — if 5 tasks need permissions simultaneously, 5 sounds play (same behavior as existing browser notifications)
- **Mobile/PWA audio** — service worker audio playback not addressed

## Dependencies

- **Teams**: None
- **Services**: None
- **Data**: No migrations
- **Timing**: No constraints. Feature is purely additive.

## New Dependencies & Configuration

| Dependency | Version | Already in project? | Install command | Why needed |
|-----------|---------|-------------------|-----------------|------------|
| None | — | — | — | Web Audio API is a browser built-in; no npm packages required |

**Audio files to create/source:**
- `web-ui/public/assets/sounds/permission.mp3` — Urgent, attention-grabbing chime (2-3 notes, ascending)
- `web-ui/public/assets/sounds/review.mp3` — Gentle notification chime (single pleasant tone)
- `web-ui/public/assets/sounds/failure.mp3` — Low/descending tone indicating something went wrong
- `web-ui/public/assets/sounds/completion.mp3` — Bright, positive chime (completion fanfare)

Each file should be ≤25KB, 1-2 seconds duration, normalized volume. Royalty-free or generated. MP3 format for universal browser support.

**Note on sourcing audio files**: The implementing agent should generate these programmatically using Web Audio API offline rendering or ffmpeg synthesis (e.g., `ffmpeg -f lavfi -i "sine=frequency=880:duration=0.3" output.mp3`), or source from a royalty-free library. Do not leave placeholder/empty files — the sounds must actually be distinct and appropriate for their event type.

**Configuration additions to `~/.quarterdeck/config.json`:**
```json
{
  "audibleNotificationsEnabled": true,
  "audibleNotificationVolume": 0.7,
  "audibleNotificationEvents": {
    "permission": true,
    "review": true,
    "failure": true,
    "completion": true
  }
}
```

## Architecture & Approach

The audible notification system layers on top of the existing visual notification infrastructure. Rather than creating a separate event detection pipeline, it hooks into the same event sources — `task_ready_for_review` for permissions/review, and `task_sessions_updated` for failure/completion — and adds audio playback as a side effect.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Audio playback engine | Web Audio API `AudioContext` + `fetch` + `decodeAudioData` | Full volume control, low latency, no DOM elements needed. Standard browser API. | `<audio>` element — simpler but no programmatic volume control without Web Audio, and managing multiple `<audio>` elements is messy | Must create AudioContext on user gesture to satisfy autoplay policy |
| Event detection for failure/completion | Derive from `task_sessions_updated` session summary diffs | These events don't have dedicated WS messages. Session summaries already contain `state`, `reviewReason`, and `exitCode`. | Add new dedicated WS events (`task_failed`, `task_completed`) — cleaner but requires backend changes for a frontend-only feature | Must track previous session state to detect transitions (not just current state) |
| Where audio logic lives | New `use-audible-notifications.ts` hook, separate from existing `use-review-ready-notifications.ts` | Separation of concerns — visual and audible notifications have different trigger conditions and settings. Keeps the existing hook untouched. | Extend existing hook — would bloat an already complex hook (245 lines) with unrelated audio concerns | Must receive the same event props as the existing notification hook |
| Sound file format | MP3 | Universal browser support, small file sizes, good compression for short sounds | OGG (better compression, not supported in Safari), WAV (larger files) | All 4 files must be MP3 |
| Settings storage | Flat fields on `RuntimeGlobalConfigFileShape` | Follows existing pattern — `readyForReviewNotificationsEnabled` is a flat boolean. Nested objects would be inconsistent. | Nested `audibleNotifications: { enabled, volume, events: {...} }` — cleaner but different from established pattern | The per-event object `audibleNotificationEvents` is the one exception to flat storage, justified by the 4-key structure |
| Tab visibility behavior | Skip if `document.visibilityState === "visible"` AND `document.hasFocus()` — no cross-tab presence check | Audio is less intrusive than OS notifications so cross-tab coordination is unnecessary for v1. Playing sounds while the user is looking at the board would be annoying. | (1) Reuse full existing logic including `hasVisibleQuarterdeckTabForWorkspace` — adds complexity for marginal benefit. (2) Always play regardless of focus — simpler but obnoxious | Check `document.visibilityState` and `document.hasFocus()` directly (not via props); omit cross-tab presence check |

## Interface Contracts

### Config Schema Additions (`api-contract.ts`)

```typescript
// Added to runtimeConfigResponseSchema
audibleNotificationsEnabled: z.boolean(),
audibleNotificationVolume: z.number().min(0).max(1),
audibleNotificationEvents: z.object({
  permission: z.boolean(),
  review: z.boolean(),
  failure: z.boolean(),
  completion: z.boolean(),
}),

// Added to runtimeConfigSaveRequestSchema (all optional)
audibleNotificationsEnabled: z.boolean().optional(),
audibleNotificationVolume: z.number().min(0).max(1).optional(),
audibleNotificationEvents: z.object({
  permission: z.boolean(),
  review: z.boolean(),
  failure: z.boolean(),
  completion: z.boolean(),
}).optional(),
```

**Note on schema asymmetry**: The `runtimeConfigSaveRequestSchema` uses `.optional()` at the top level (the entire `audibleNotificationEvents` object is optional), but when present, all 4 event fields are required booleans. This is intentional: the frontend settings dialog always sends complete event objects. Partial updates (e.g., changing only `permission`) happen at the config file merge layer in `RuntimeGlobalConfigFileShape`, where individual event fields are optional and merged with defaults via `??`.

### Audible Notification Event Types

```typescript
type AudibleNotificationEventType = "permission" | "review" | "failure" | "completion";
```

### Session State → Sound Event Mapping

Every combination of session `state` and `reviewReason` is explicitly mapped below. The session state enum is `idle | running | awaiting_review | failed | interrupted`. The review reason enum is `hook | attention | exit | error | interrupted | null`.

| Session State | Review Reason | Additional Condition | Sound Event | Rationale |
|---------------|--------------|---------------------|-------------|-----------|
| `awaiting_review` | `hook` | `isApprovalState()` is true | `permission` | Agent needs user to approve a permission request |
| `awaiting_review` | `hook` | `isApprovalState()` is false | `review` | Agent moved task to review via hook (non-permission) |
| `awaiting_review` | `attention` | — | `review` | Agent wants user attention ("Waiting for input"); closest match to review sound |
| `awaiting_review` | `exit` | `exitCode === 0` | `completion` | Agent exited successfully |
| `awaiting_review` | `exit` | `exitCode !== 0` OR `exitCode === null` | `failure` | Agent exited with error code or unknown exit |
| `awaiting_review` | `error` | — | `failure` | Agent session errored |
| `awaiting_review` | `interrupted` | — | no sound | User-initiated interrupt (Ctrl+C); user already knows |
| `failed` | any | — | `failure` | Direct PTY crash / process failure |
| `interrupted` | any | — | no sound | User-initiated interrupt; no notification needed |
| `idle` | any | — | no sound | Session not active |
| `running` | any | — | no sound | Session is actively running, no notification needed |

**Detection paths**:
- `permission` and `review` (from `hook` reason): Detected via `task_ready_for_review` WebSocket message, same as existing browser notifications.
- `review` (from `attention` reason): Detected via `task_sessions_updated` session state diff, since there is no dedicated `task_ready_for_review` message for attention events.
- `failure` and `completion`: Detected via `task_sessions_updated` session state diff.
- `interrupted` and `idle`: No sound, no detection needed.

## Implementation Phases

### Phase 1: Audio Engine & Sound Files

#### Overview

Create the core audio playback infrastructure and bundle the sound files. This phase has no UI or settings — it's the foundation that Phase 2 builds on.

#### Changes Required

##### 1. Sound Files

**Directory**: `web-ui/public/assets/sounds/`
**Action**: Add (create directory and 4 MP3 files)
**Changes**:
- Create `permission.mp3` — urgent ascending chime, ~1s
- Create `review.mp3` — gentle single-tone notification, ~0.8s
- Create `failure.mp3` — low descending tone, ~1s
- Create `completion.mp3` — bright positive chime, ~0.8s

##### 2. Audio Playback Utility

**File**: `web-ui/src/utils/notification-audio.ts`
**Action**: Add (new file)
**Changes**:
- Define `AudibleNotificationEventType` type: `"permission" | "review" | "failure" | "completion"`
- Define `NOTIFICATION_SOUND_URLS` constant mapping each event type to its `/assets/sounds/*.mp3` URL
- Create `NotificationAudioPlayer` class:
  - Private `audioContext: AudioContext | null` — lazily created
  - Private `audioBuffers: Map<AudibleNotificationEventType, AudioBuffer>` — decoded audio cache
  - `ensureContext(): AudioContext` — creates or resumes AudioContext (handles autoplay policy). If the context is in `"suspended"` state, call `context.resume()`.
  - `preloadSounds(): Promise<void>` — calls `ensureContext()` internally, then fetches and decodes all 4 MP3 files into `audioBuffers`. Uses `fetch()` + `audioContext.decodeAudioData()`. Silently catches failures (network errors, decode errors) so a missing sound file doesn't break the app. Skips already-loaded buffers on subsequent calls (safe to call multiple times).
  - `play(eventType: AudibleNotificationEventType, volume: number): void` — creates a `BufferSourceNode` + `GainNode`, clamps `volume` to the 0.0–1.0 range (values below 0 become 0, values above 1 become 1), sets gain to the clamped volume, connects to `audioContext.destination`, and starts playback. No-ops if the buffer for that event type isn't loaded. No-ops if `audioContext` is null or suspended and cannot be resumed.
  - `dispose(): void` — closes the AudioContext and clears buffers
- Export a singleton `notificationAudioPlayer` instance

**Code Pattern to Follow**: The utility follows the same module-level singleton pattern as `web-ui/src/utils/notification-badge-sync.ts` — no React dependency, plain TypeScript, exported functions/objects.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] TypeScript compiles: `npm run web:typecheck`
- [ ] Lint passes: `npm run lint`

##### Behavioral

- [ ] Sound files exist and are loadable: open browser dev tools network tab, navigate to `http://127.0.0.1:4173/assets/sounds/permission.mp3` — audio plays
- [ ] `NotificationAudioPlayer.play("permission", 0.7)` plays a sound (test in browser console after importing)

**Checkpoint**: Pause here for verification before proceeding to Phase 2.

---

### Phase 2: Settings Infrastructure

#### Overview

Add the audible notification settings to the config persistence chain — from the Zod schema through server config to the frontend config hook. No UI yet — this makes the settings available for Phase 3's UI and Phase 4's notification hook.

#### Changes Required

##### 1. API Contract Schema

**File**: `src/core/api-contract.ts`
**Action**: Modify
**Location**: `runtimeConfigResponseSchema` (around line 543) and `runtimeConfigSaveRequestSchema` (around line 562)
**Changes**:
- Add to `runtimeConfigResponseSchema`:
  - `audibleNotificationsEnabled: z.boolean()`
  - `audibleNotificationVolume: z.number().min(0).max(1)`
  - `audibleNotificationEvents: z.object({ permission: z.boolean(), review: z.boolean(), failure: z.boolean(), completion: z.boolean() })`
- Add to `runtimeConfigSaveRequestSchema`:
  - `audibleNotificationsEnabled: z.boolean().optional()`
  - `audibleNotificationVolume: z.number().min(0).max(1).optional()`
  - `audibleNotificationEvents: z.object({ permission: z.boolean(), review: z.boolean(), failure: z.boolean(), completion: z.boolean() }).optional()`

**Code Pattern to Follow**: See existing `readyForReviewNotificationsEnabled` field in the same schemas.

##### 2. Runtime Config Types & Persistence

**File**: `src/config/runtime-config.ts`
**Action**: Modify
**Location**: `RuntimeGlobalConfigFileShape` (line 14), `RuntimeConfigState` (line 27), `RuntimeConfigUpdateInput` (line 41), defaults (around line 54), and read/write functions
**Changes**:
- Add to `RuntimeGlobalConfigFileShape`:
  - `audibleNotificationsEnabled?: boolean`
  - `audibleNotificationVolume?: number`
  - `audibleNotificationEvents?: { permission?: boolean; review?: boolean; failure?: boolean; completion?: boolean }`
- Add to `RuntimeConfigState`:
  - `audibleNotificationsEnabled: boolean`
  - `audibleNotificationVolume: number`
  - `audibleNotificationEvents: { permission: boolean; review: boolean; failure: boolean; completion: boolean }`
- Add to `RuntimeConfigUpdateInput`:
  - `audibleNotificationsEnabled?: boolean`
  - `audibleNotificationVolume?: number`
  - `audibleNotificationEvents?: { permission?: boolean; review?: boolean; failure?: boolean; completion?: boolean }`
- Add default constants:
  - `DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED = true`
  - `DEFAULT_AUDIBLE_NOTIFICATION_VOLUME = 0.7`
  - `DEFAULT_AUDIBLE_NOTIFICATION_EVENTS = { permission: true, review: true, failure: true, completion: true }`
- In `toRuntimeConfigState()` (around line 240): read the new fields from the file shape, applying defaults via `??` for missing values. For the events object, merge with defaults to handle partially-specified objects (e.g., if only `permission` is set in the file, the rest default to `true`).
- In `writeRuntimeGlobalConfigFile()` (around line 300): include the new fields in the written JSON.
- In `updateRuntimeConfig()` (around line 530): handle the new fields in the merge logic.

**Code Pattern to Follow**: See how `readyForReviewNotificationsEnabled` is handled at each of these locations — the new fields follow the exact same chain.

##### 3. tRPC Config Handler

**File**: `src/trpc/runtime-api.ts`
**Action**: Modify
**Location**: `buildConfigResponse()` (around line 57) and `saveConfig` handler (around line 75)
**Changes**:
- In `buildConfigResponse()`: map the new `RuntimeConfigState` fields to the response schema
- In `saveConfig`: pass the new fields through to `updateRuntimeConfig()`

**Code Pattern to Follow**: See how `readyForReviewNotificationsEnabled` is mapped in the same function.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Runtime tests pass: `npm run test`
- [ ] TypeScript compiles: `npm run typecheck && npm run web:typecheck`
- [ ] Lint passes: `npm run lint`

##### Behavioral

- [ ] Start runtime (`npm run dev`), hit `GET /api/runtime/config` — response includes `audibleNotificationsEnabled: true`, `audibleNotificationVolume: 0.7`, `audibleNotificationEvents: { permission: true, review: true, failure: true, completion: true }`
- [ ] `POST /api/runtime/config` with `{ audibleNotificationsEnabled: false }` — value persists in `~/.quarterdeck/config.json` and subsequent GET returns `false`

**Checkpoint**: Pause here for verification before proceeding to Phase 3.

---

### Phase 3: Settings UI

#### Overview

Add audible notification controls to the existing settings dialog. Users can toggle sounds on/off globally, enable/disable per event type, and adjust volume.

#### Changes Required

##### 1. Settings Dialog

**File**: `web-ui/src/components/runtime-settings-dialog.tsx`
**Action**: Modify
**Location**: After the existing "Notifications" section (around line 679)
**Changes**:
- Add local state for the 3 new settings (mirroring existing pattern):
  - `const [audibleNotificationsEnabled, setAudibleNotificationsEnabled] = useState(true)`
  - `const [audibleNotificationVolume, setAudibleNotificationVolume] = useState(0.7)`
  - `const [audibleNotificationEvents, setAudibleNotificationEvents] = useState({ permission: true, review: true, failure: true, completion: true })`
- Sync from loaded config in the existing `useEffect` that runs on dialog open (around line 399)
- Include in the `hasUnsavedChanges` comparison (around line 357)
- Include in the `handleSave()` payload (around line 496)
- Add UI after the existing notifications toggle (around line 679):

```
<h6>Sound notifications</h6>
[Master toggle — RadixSwitch.Root]
  "Play sounds when tasks need attention"

[Volume slider — <input type="range"> with 0-100 mapping to 0.0-1.0]
  "Volume" label + current percentage display
  Disabled when master toggle is off

[Per-event toggles — 4 RadixCheckbox.Root items]
  ☑ Permissions — "Task is waiting for approval"
  ☑ Review — "Task is ready for review"  
  ☑ Failure — "Agent session failed or errored"
  ☑ Completion — "Task completed successfully"
  All disabled when master toggle is off

[Test sound button — Button size="sm"]
  "Test sound" — plays the permission sound at current volume
  Disabled when master toggle is off
```

- The "Test sound" button calls `notificationAudioPlayer.preloadSounds()` (which calls `ensureContext()` internally) then `notificationAudioPlayer.play("permission", volume)`. This also serves as the user gesture needed to unlock the AudioContext. There is no need to call `ensureContext()` separately — `preloadSounds()` handles it.

**Code Pattern to Follow**: See the existing `readyForReviewNotificationsEnabled` toggle at lines 656-679 for the RadixSwitch pattern. See checkbox pattern at lines 581-601 for autonomous mode.

##### 2. Preload Sounds on App Mount

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Location**: Near the top-level effects (around line 293)
**Changes**:
- Import `notificationAudioPlayer` from `@/utils/notification-audio`
- Add a `useEffect` that calls `notificationAudioPlayer.preloadSounds()` once on mount. This pre-fetches and decodes the audio files so they're ready for instant playback. `preloadSounds()` calls `ensureContext()` internally — most browsers allow `decodeAudioData` on a suspended AudioContext, so preloading works before any user gesture. The `preloadSounds` method handles errors silently.

**Note on AudioContext unlock retry**: The Phase 4 user-gesture click handler calls `ensureContext()` to unlock a suspended AudioContext. After calling `ensureContext()`, it should also call `preloadSounds()` if the audio buffers are empty (i.e., if the initial preload failed due to a suspended context that rejected `decodeAudioData`). This is a resilience path — most browsers won't need it.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Web UI tests pass: `npm run web:test`
- [ ] TypeScript compiles: `npm run web:typecheck`
- [ ] Lint passes: `npm run lint`

##### Behavioral

- [ ] Open settings dialog → "Sound notifications" section is visible with master toggle, volume slider, 4 event checkboxes, and test button
- [ ] Toggle master off → volume slider and event checkboxes are visually disabled
- [ ] Click "Test sound" → hear the permission chime at the set volume
- [ ] Adjust volume slider → "Test sound" plays at new volume
- [ ] Save → close → reopen settings → values are preserved
- [ ] Uncheck "Review" → save → reopen → "Review" remains unchecked

**Checkpoint**: Pause here for verification before proceeding to Phase 4.

---

### Phase 4: Notification Hook — Event Detection & Audio Playback

#### Overview

Create the audible notification hook that detects task events and plays the appropriate sounds. This is the core feature logic.

#### Changes Required

##### 1. Audible Notification Hook

**File**: `web-ui/src/hooks/use-audible-notifications.ts`
**Action**: Add (new file)
**Changes**:
- Define `UseAudibleNotificationsOptions` interface:
  ```typescript
  interface UseAudibleNotificationsOptions {
    activeWorkspaceId: string | null;
    latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
    taskSessions: Record<string, RuntimeTaskSessionSummary>;
    audibleNotificationsEnabled: boolean;
    audibleNotificationVolume: number;
    audibleNotificationEvents: {
      permission: boolean;
      review: boolean;
      failure: boolean;
      completion: boolean;
    };
  }
  ```
  Note: There is no `isDocumentVisible` prop. The hook reads `document.visibilityState` and `document.hasFocus()` directly inside its effects, matching the pattern at `use-review-ready-notifications.ts:169-170`. This makes the hook self-contained for visibility checks and avoids prop/DOM timing mismatches.
- Implement `useAudibleNotifications(options)`:

  **Permission & Review detection** (from `latestTaskReadyForReview`):
  - `useEffect` with `latestTaskReadyForReview` in deps
  - Guard: skip if `!audibleNotificationsEnabled`, or `activeWorkspaceId` is null, or workspace mismatch, or tab is visible and focused (read `document.visibilityState === "visible"` AND `document.hasFocus()` directly inside the effect — no cross-tab presence check, see design decisions table)
  - Deduplicate via `useRef<Set<string>>` with event keys (same pattern as existing hook, line 86-87)
  - Look up the session summary for the task to call `isApprovalState()` — use the real `isApprovalState()` function from `@/utils/session-status.ts`, not a reimplementation
  - If approval state → play `"permission"` (if `audibleNotificationEvents.permission`)
  - Else → play `"review"` (if `audibleNotificationEvents.review`)
  - Call `notificationAudioPlayer.play(eventType, audibleNotificationVolume)`

  **Failure, Completion, & Attention detection** (from `taskSessions`):
  - `useRef<Map<string, string>>` to track previous session states per task ID (key format: `"${state}:${reviewReason}:${exitCode}"`)
  - `useEffect` with `taskSessions` in deps
  - On each update, compare current session state against previous:
    - `state === "awaiting_review"` + `reviewReason === "error"` → play `"failure"` (if `audibleNotificationEvents.failure`)
    - `state === "awaiting_review"` + `reviewReason === "exit"` + `exitCode === 0` → play `"completion"` (if `audibleNotificationEvents.completion`)
    - `state === "awaiting_review"` + `reviewReason === "exit"` + (`exitCode !== 0` OR `exitCode === null`) → play `"failure"` (if `audibleNotificationEvents.failure`)
    - `state === "awaiting_review"` + `reviewReason === "attention"` → play `"review"` (if `audibleNotificationEvents.review`)
    - `state === "awaiting_review"` + `reviewReason === "interrupted"` → no sound (user-initiated)
    - `state === "failed"` → play `"failure"` (if `audibleNotificationEvents.failure`)
    - `state === "interrupted"` → no sound (user-initiated)
  - Guard: skip if `!audibleNotificationsEnabled`, or `activeWorkspaceId` is null, or tab is visible and focused (read `document.visibilityState` and `document.hasFocus()` directly inside the effect, same as above)
  - Update the previous-state ref after processing
  - Only fire for transitions that just happened (compare against previous snapshot), not for initial load. On first render, populate the ref with current states without playing sounds.
  - When `activeWorkspaceId` changes, clear the previous session state ref to prevent spurious sounds from the new workspace's pre-existing sessions.

  **AudioContext resume on user gesture**:
  - `useEffect` that adds a one-time `click` event listener to `document` which calls `notificationAudioPlayer.ensureContext()`, then calls `notificationAudioPlayer.preloadSounds()` if audio buffers are empty (resilience retry — handles browsers that rejected `decodeAudioData` on suspended context during initial preload). Remove listener after first call. This ensures the AudioContext is unlocked even if the user never opens settings.

**Code Pattern to Follow**: See `web-ui/src/hooks/use-review-ready-notifications.ts` for the deduplication pattern (Set<string> + queue with max size), visibility checks, and event key construction.

##### 2. Wire Hook in App.tsx

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Location**: After the existing `useReviewReadyNotifications` call (around line 301)
**Changes**:
- Import `useAudibleNotifications` from `@/hooks/use-audible-notifications`
- Read audible notification settings from `runtimeProjectConfig` (same pattern as `readyForReviewNotificationsEnabled` at line 172):
  ```typescript
  const audibleNotificationsEnabled = runtimeProjectConfig?.audibleNotificationsEnabled ?? true;
  const audibleNotificationVolume = runtimeProjectConfig?.audibleNotificationVolume ?? 0.7;
  const audibleNotificationEvents = runtimeProjectConfig?.audibleNotificationEvents ?? {
    permission: true, review: true, failure: true, completion: true,
  };
  ```
- Call the hook:
  ```typescript
  useAudibleNotifications({
    activeWorkspaceId: activeNotificationWorkspaceId,
    latestTaskReadyForReview,
    taskSessions: sessions,
    audibleNotificationsEnabled,
    audibleNotificationVolume,
    audibleNotificationEvents,
  });
  ```

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] All tests pass: `npm run check`

##### Behavioral

- [ ] Start a task → when it requests permissions, hear the permission sound (tab must not be focused — switch to another tab)
- [ ] Agent completes and moves to review → hear the review sound
- [ ] Agent exits with error → hear the failure sound
- [ ] Agent exits successfully → hear the completion sound
- [ ] Disable "Permissions" in settings → no sound on permission request (but browser notification still shows)
- [ ] Set volume to 0% → no audible sound on any event
- [ ] Disable master toggle → no sounds on any event
- [ ] Keep tab focused → no sounds play (visual notification is sufficient)

**Checkpoint**: This is the final phase.

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| Sound file fails to load (404, network error) | `preloadSounds()` catches silently; `play()` no-ops for missing buffer | Remove a sound file, restart — no console errors, other sounds still work |
| AudioContext creation fails (browser restriction) | `ensureContext()` catches and returns null; `play()` no-ops | Test in a restrictive browser environment |
| AudioContext suspended (autoplay policy) | `ensureContext()` calls `context.resume()`; if still suspended, `play()` no-ops | Open fresh tab without interacting — no errors; click anywhere — audio works |
| Config has invalid volume (negative, >1) | Zod schema validation rejects at API boundary; frontend clamps to 0-1 range | POST invalid volume via API — returns 400 |
| Config has partial `audibleNotificationEvents` | Server merges with defaults — missing keys default to `true` | Save config with only `{ permission: false }` — other events remain `true` |

## Rollback Strategy

- **Phase 1 rollback**: Delete `web-ui/public/assets/sounds/` and `web-ui/src/utils/notification-audio.ts`
- **Phase 2 rollback**: Revert schema additions in `api-contract.ts`, type additions in `runtime-config.ts`, handler changes in `runtime-api.ts`. Existing config files with the new fields are harmless — unknown fields are ignored on read.
- **Phase 3 rollback**: Revert settings dialog changes, remove preload effect from App.tsx
- **Phase 4 rollback**: Delete `use-audible-notifications.ts`, revert App.tsx wiring
- **Full rollback**: Revert all 4 phases. Delete sound files. The `config.json` fields are harmless if left behind.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Browser autoplay policy blocks audio | Medium | Medium | AudioContext resume on user gesture (click listener + settings test button). Common pattern with well-known workarounds. |
| Sound files too large or poor quality | Low | Low | Cap at 25KB each, 1-2s duration. Generate programmatically if needed. |
| Rapid-fire sounds annoying (e.g., 5 tasks fail simultaneously) | Low | Medium | Out of scope for v1. If reported, add a simple cooldown (e.g., 2s min between same event type). The existing notification hook doesn't throttle either. |
| Session state change detection misses edge cases | Medium | Low | The `task_sessions_updated` path may deliver batch updates. The diff logic must handle multiple sessions changing in one update. |

## Implementation Notes / Gotchas

- **AudioContext singleton**: Create only ONE AudioContext for the entire app lifetime. Browsers limit the number of AudioContexts (typically 6). The singleton in `notification-audio.ts` handles this.
- **Preload timing**: `preloadSounds()` should run on app mount but NOT block rendering. It's a fire-and-forget async operation.
- **Session state diffing**: The `task_sessions_updated` WebSocket message delivers a batch of session summaries. The hook must compare ALL sessions against their previous state, not just assume one changed. Use a `Map<taskId, previousState>` ref.
- **Initial load**: When the app first connects and receives the `snapshot` message, all existing sessions will appear "new". The hook must populate its previous-state ref from the initial snapshot WITHOUT playing sounds. Only transitions that happen after the initial snapshot should trigger audio.
- **Volume slider UX**: Use `<input type="range" min="0" max="100" step="1">` and convert to 0.0-1.0 for the API. Displaying percentage is more intuitive than a 0-1 float.
- **Test sound button**: This is the primary mechanism for unlocking AudioContext via user gesture. The settings dialog is the natural place for this because users will interact with it when setting up notifications.
- **Board state single-writer rule**: This feature does NOT modify board state. It only reads from the WebSocket stream and plays audio. No conflict with the single-writer rule.
- **Rapid-fire sound overlap**: Multiple simultaneous `play()` calls create overlapping audio — each call creates a new `BufferSourceNode` + `GainNode` chain, so sounds stack. This is expected and acceptable for v1. If it becomes annoying in practice, a cooldown per event type can be added later (see Risks table).
- **Biome formatting**: Indent with tabs, indent width 3, line width 120.

## References

- **Ticket**: #14
- **Planned feature doc**: `docs/planned-features.md:182-201`
- **Related files**:
  - `web-ui/src/hooks/use-review-ready-notifications.ts` — existing notification hook (reference pattern)
  - `web-ui/src/utils/session-status.ts` — session state classification
  - `web-ui/src/utils/notification-badge-sync.ts` — singleton utility pattern
  - `src/config/runtime-config.ts` — config persistence chain
  - `src/core/api-contract.ts` — API schemas
  - `web-ui/src/components/runtime-settings-dialog.tsx` — settings UI
- **Test Spec**: [2026-04-07-audible-notifications-tests.md](2026-04-07-audible-notifications-tests.md)
