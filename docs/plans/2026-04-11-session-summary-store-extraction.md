# Session Summary Store Extraction

## Overview

Extract a `SessionSummaryStore` service from `TerminalSessionManager` to decouple session summary state management from terminal process lifecycle. The store owns all `RuntimeTaskSessionSummary` data, mutations, and change subscriptions. The terminal manager delegates to the store for summary operations and retains ownership of PTY processes, output listeners, restart logic, and reconciliation.

This is todo #17 (decouple session summary dual-sourcing). The design targets a clean Go interface so the refactor transfers directly to the Go backend rewrite (todo #1).

## Current State

`TerminalSessionManager` (`src/terminal/session-manager.ts`) is a 1348-line god object that owns both:
1. **Session summaries** — a `Map<string, SessionEntry>` where each entry's `.summary` field holds `RuntimeTaskSessionSummary` (pure data). Mutations go through `updateSummary()` (line 152) and broadcasts go through `emitSummary()` (line 1342).
2. **PTY process lifecycle** — spawn, output handling, exit, auto-restart, workspace trust, reconciliation.

External code reaches into the manager for summary operations:
- **Read-back**: `listSummaries()` called by workspace-api:492, workspace-registry:306/323, shutdown-coordinator:134. `getSummary()` called by workspace-api:307, runtime-api:158/395, hooks-api:97, shutdown-coordinator:178.
- **Mutations**: `transitionToReview`, `transitionToRunning`, `applyHookActivity`, `appendConversationSummary`, `setDisplaySummary`, `applyTurnCheckpoint` — all in hooks-api and runtime-api.
- **Lifecycle**: `hydrateFromRecord` (workspace-registry:241), `onSummary` (runtime-state-hub:473), `markInterruptedAndStopAll` (shutdown-coordinator:163, workspace-registry:279).

The problematic coupling: persistence reaches back into the terminal layer (`workspace-api.ts:492: for (const summary of terminalManager.listSummaries())`), and TRPC handlers make 10+ direct mutation calls into the terminal layer.

Research doc: `docs/research/2026-04-10-session-summary-dual-sourcing.md`.

## Desired End State

```
SessionSummaryStore (owns Map<taskId, Summary>)
  │ onChange() subscription
  ├── RuntimeStateHub subscribes → WebSocket broadcast
  ├── workspace-api reads via listSummaries() → persistence
  ├── workspace-registry reads via listSummaries() → project counts, snapshots
  ├── shutdown-coordinator reads via getSummary()/listSummaries() → interrupt persistence
  └── hooks-api/runtime-api mutate via store methods → state transitions

TerminalSessionManager (owns PTY lifecycle)
  │ Has-a SessionSummaryStore (injected)
  ├── Calls store.update() during PTY events (onData, onExit)
  ├── Calls store.applySessionEvent() for state machine transitions
  ├── Still owns: listeners, restart logic, reconciliation, resize, write
  └── Notifies per-session listeners after store mutations
```

Verification:
- `TerminalSessionManager` no longer has `getSummary`, `listSummaries`, `onSummary`, `hydrateFromRecord`, `transitionToReview`, `transitionToRunning`, `applyHookActivity`, `appendConversationSummary`, `setDisplaySummary`, `applyTurnCheckpoint`, or `markInterruptedAndStopAll` on its public surface.
- External callers import `SessionSummaryStore` (the interface) instead of `TerminalSessionManager` for summary operations.
- All existing tests pass. New store-focused tests cover the extracted logic.

## Out of Scope

- **Event bus for mutations** (Option B from research doc) — over-engineered for this codebase, and the Go rewrite won't use one.
- **Splitting PTY lifecycle out of session-manager** — the manager is still the right home for process wiring; we're only extracting the data layer.
- **Changing the persistence flow** — the single-writer rule (UI persists board state) stays. The store replaces where persistence reads from, not how it writes.
- **Modifying the WebSocket protocol** — `task_sessions_updated` messages stay the same; only the source of summaries changes.

## Dependencies

- **Teams**: None — solo project.
- **Services**: None.
- **Data**: No migrations. The store hydrates from the same persisted `sessions.json` format.
- **Timing**: No release constraints. Should be done before the Go rewrite starts to establish the interface contract.

## Implementation Approach

Extract summary state management into a standalone `SessionSummaryStore` class, injected into `TerminalSessionManager`. The store is a plain synchronous class (no async, no event loop tricks) — it owns the summary Map, the state machine transitions, and the onChange subscription. The session-manager calls store methods where it previously called internal helpers.

The key insight is that `SessionEntry` in session-manager bundles two concerns: summary data and process state. The store takes ownership of the summary half. The session-manager retains a parallel map of process entries (active PTY, listeners, restart state) keyed by taskId. The two maps stay in sync via the manager calling `store.ensureEntry()` when it creates a process entry.

The session state machine (`reduceSessionTransition` in `session-state-machine.ts`) is already a pure function — it stays where it is. The store calls it.

---

## Phase 1: Create `SessionSummaryStore` interface + implementation

### Overview

Define the `SessionSummaryStore` interface and build the `InMemorySessionSummaryStore` concrete class. Extract all summary-related logic from `TerminalSessionManager`:
- Summary CRUD (`createDefaultSummary`, `cloneSummary`, `updateSummary`)
- State machine transitions (`transitionToReview`, `transitionToRunning`, `applySessionEvent`)
- Hook activity merging (`applyHookActivity`)
- Conversation summary management (`appendConversationSummary`)
- Display summary (`setDisplaySummary`)
- Turn checkpoints (`applyTurnCheckpoint`)
- Hydration (`hydrateFromRecord`)
- Subscription (`onChange`/`emitSummary`)
- Bulk operations (`markAllInterrupted`, `listSummaries`, `getSummary`)

### Changes Required

#### 1. New file: `src/terminal/session-summary-store.ts`

**File**: `src/terminal/session-summary-store.ts` (new)
**Changes**: Define the interface and implementation.

The interface should be:

```typescript
export interface SessionSummaryStore {
	// Reads
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];

	// Lifecycle
	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void;
	ensureEntry(taskId: string): RuntimeTaskSessionSummary;

	// Low-level update (used by session-manager for PTY event patches)
	update(taskId: string, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary | null;

	// State machine transitions
	applySessionEvent(taskId: string, event: SessionTransitionEvent): { summary: RuntimeTaskSessionSummary; changed: boolean; clearAttentionBuffer: boolean } | null;

	// Domain mutations
	transitionToReview(taskId: string, reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary | null;
	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null;
	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null;
	appendConversationSummary(taskId: string, entry: { text: string; capturedAt: number }): RuntimeTaskSessionSummary | null;
	setDisplaySummary(taskId: string, text: string, generatedAt: number | null): RuntimeTaskSessionSummary | null;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;

	// Bulk operations
	markAllInterrupted(activeTaskIds: string[]): RuntimeTaskSessionSummary[];

	// Recovery
	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null;

	// Subscription
	onChange(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
}
```

The `InMemorySessionSummaryStore` class:
- Holds `private readonly entries = new Map<string, RuntimeTaskSessionSummary>()`
- Holds `private readonly listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>()`
- Moves `createDefaultSummary()`, `cloneSummary()`, `updateSummary()` (adapted to work on the flat Map), and `emitSummary()` from session-manager.ts
- Moves the full `applyHookActivity()` logic (lines 867-951 of session-manager.ts) — the hook activity merging with isNewEvent/carry-forward semantics
- Moves `appendConversationSummary()` logic (lines 953-1019) — retention caps, LLM summary preservation
- Moves `setDisplaySummary()` logic (lines 1026-1042)
- Moves `applyTurnCheckpoint()` logic (lines 1069-1091)
- Moves `transitionToReview()` and `transitionToRunning()` — but NOTE: these currently interact with `entry.active` (checking process liveness, clearing `awaitingCodexPromptAfterEnter`). The store version operates on summary data only. The session-manager wrapper handles the process-state side effects.
- Moves `recoverStaleSession()` summary logic (lines 742-772) — the summary reset part, not the listener notification part
- The `applySessionEvent()` method wraps `reduceSessionTransition()` and applies the patch. Returns a result object so the caller (session-manager) can handle side effects like clearing the attention buffer on the active process.
- `markAllInterrupted()` takes a list of active taskIds (from the manager), marks their summaries as interrupted, and returns the snapshots.

Key design decisions:
- All mutation methods emit via `onChange` automatically. The session-manager does NOT need to call emit separately.
- All returned summaries are cloned (defensive copies). Same behavior as current session-manager.
- `update()` is the low-level escape hatch for the session-manager's PTY callbacks (e.g., `{ lastOutputAt: now() }` patches during onData). It also emits.
- The store is synchronous. No promises, no async. This matches the current behavior and is what Go expects.

#### 2. Import the DISPLAY_SUMMARY_MAX_LENGTH constant

The `appendConversationSummary` logic references `DISPLAY_SUMMARY_MAX_LENGTH` from `src/title/llm-client.ts`. The store will import this directly.

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] New file compiles without errors
- [ ] Store can be instantiated and basic operations work (will be tested in Phase 4, but should compile now)

#### Manual

- [ ] Review the interface — does it map cleanly to a Go interface? Every method should be expressible as a Go method signature.
- [ ] Verify no async or process-specific logic leaked into the store.

**Checkpoint**: The store exists as a standalone module. No other files are modified yet.

---

## Phase 2: Wire `SessionSummaryStore` into `TerminalSessionManager`

### Overview

Inject the store into `TerminalSessionManager` and replace all internal summary operations with store calls. The manager's constructor takes a `SessionSummaryStore` parameter. The `ensureEntry()` method creates entries in both the store (summary) and the manager's local map (process state). PTY callbacks call `store.update()` instead of the old `updateSummary()`. State transitions call `store.applySessionEvent()` and handle side effects (clearing attention buffer, resetting codex flags) based on the result.

### Changes Required

#### 1. Modify `TerminalSessionManager` constructor

**File**: `src/terminal/session-manager.ts`
**Changes**:
- Add `readonly store: SessionSummaryStore` as a constructor parameter
- Remove `private readonly summaryListeners` — this lives in the store now
- The `entries` Map becomes `ProcessEntry` — a slimmed type that no longer contains `summary`:

```typescript
interface ProcessEntry {
	taskId: string;
	active: ActiveProcessState | null;
	terminalStateMirror: TerminalStateMirror | null;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
	pendingExitResolvers: Array<() => void>;
}
```

#### 2. Replace all `updateSummary()` + `emitSummary()` pairs

**File**: `src/terminal/session-manager.ts`
**Changes**: Every `updateSummary(entry, patch)` + `this.emitSummary(summary)` pair becomes `this.store.update(taskId, patch)`. There are 18 emit sites to convert.

Specific replacements:
- **onData callback** (line 434): `updateSummary(entry, { lastOutputAt: now() })` → `this.store.update(request.taskId, { lastOutputAt: now() })`
- **Output transition detection** (line 458-465): `this.applySessionEvent(entry, adapterEvent)` + `this.emitSummary(summary)` → `const result = this.store.applySessionEvent(taskId, adapterEvent)` + handle `clearAttentionBuffer` side effect
- **onExit callback** (lines 485-501): `this.applySessionEvent(entry, { type: "process.exit", ... })` + emit → `this.store.applySessionEvent(taskId, ...)` + notify listeners
- **Spawn failure** (line 522-537): `updateSummary` + `emitSummary` → `this.store.update(taskId, { state: "failed", ... })`
- **Task session started** (lines 567-582): Initial state setup → `this.store.update(taskId, { state: "running", ... })`
- **Shell session lifecycle** — same pattern as task session
- **recoverStaleSession** (lines 742-771): Summary reset → `this.store.recoverStaleSession(taskId)` + notify listeners
- **Auto-restart warning** (line 1220-1228): `updateSummary` + `emitSummary` → `this.store.update(taskId, { warningMessage: ... })`
- **Reconciliation actions** (lines 1276-1313): `applySessionEvent` + `emitSummary` → `this.store.applySessionEvent(taskId, ...)` or `this.store.update(taskId, ...)`
- **Interrupt recovery** (lines 1334-1338): Same pattern

#### 3. Remove delegated methods from public surface

**File**: `src/terminal/session-manager.ts`
**Changes**: Remove these methods entirely — they now live on the store:
- `getSummary()` (line 287)
- `listSummaries()` (line 292)
- `onSummary()` (line 263)
- `hydrateFromRecord()` (line 270)
- `transitionToReview()` (line 843)
- `transitionToRunning()` (line 1044) and `applyTransitionToRunning()` (line 1053)
- `applyHookActivity()` (line 867)
- `appendConversationSummary()` (line 953)
- `setDisplaySummary()` (line 1026)
- `applyTurnCheckpoint()` (line 1069)

Keep but modify:
- `markInterruptedAndStopAll()` (line 1130) — still stops processes, but delegates summary marking to `this.store.markAllInterrupted(activeTaskIds)`
- `recoverStaleSession()` (line 742) — still notifies listeners, delegates summary to store

#### 4. Preserve listener notification pattern

**File**: `src/terminal/session-manager.ts`
**Changes**: After store mutations that affect active sessions, the manager still notifies per-session listeners (`entry.listeners`) with the updated summary. Pattern:

```typescript
const summary = this.store.applyHookActivity(taskId, activity);
if (summary) {
	const processEntry = this.entries.get(taskId);
	if (processEntry?.active) {
		for (const listener of processEntry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
	}
}
```

This is the one area where the manager still reads from the store after a mutation — to relay state to per-terminal UI listeners. This is intentional: per-session listeners are a terminal concern (they're attached via `attach()` when a browser opens a terminal panel), not a summary concern.

#### 5. Update `ensureEntry()` to coordinate both maps

**File**: `src/terminal/session-manager.ts`
**Changes**: The private `ensureEntry()` method (line 1159) now creates entries in both the store and the local process map:

```typescript
private ensureProcessEntry(taskId: string): ProcessEntry {
	const existing = this.entries.get(taskId);
	if (existing) return existing;
	this.store.ensureEntry(taskId); // creates summary in store
	const created: ProcessEntry = {
		taskId,
		active: null,
		// ... (no summary field)
	};
	this.entries.set(taskId, created);
	return created;
}
```

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] All existing tests pass: `npm run test` (tests that directly construct `TerminalSessionManager()` will need updating — they now must pass a store)

#### Manual

- [ ] `TerminalSessionManager` no longer has summary-related methods on its public surface (except `store` accessor)
- [ ] The `entries` Map type no longer contains `summary`

**Checkpoint**: The session-manager is rewired. External callers still reference the manager (they'll break at the type level until Phase 3).

---

## Phase 3: Update external callers to use the store directly

### Overview

Change dependency injection across 6 files so external code uses `SessionSummaryStore` for summary operations and `TerminalSessionManager` only for process operations.

### Changes Required

#### 1. `src/server/workspace-registry.ts`

**File**: `src/server/workspace-registry.ts`
**Changes**:
- `ensureTerminalManagerForWorkspace()` (line 221) now also creates and holds the store. The store is created first, then injected into the manager:
  ```typescript
  const store = new InMemorySessionSummaryStore();
  const manager = new TerminalSessionManager(store);
  store.hydrateFromRecord(existingWorkspace.sessions);
  ```
- Expose a `getSessionSummaryStoreForWorkspace(workspaceId)` method alongside `getTerminalManagerForWorkspace()`.
- Or: expose the store via the manager (`manager.store`). Simpler, avoids a parallel map. The dependency interfaces in callers can destructure what they need.
- `summarizeProjectTaskCounts()` (line 293): Change `terminalManager.listSummaries()` → `terminalManager.store.listSummaries()` (or get store directly)
- `buildWorkspaceStateSnapshot()` (line 317): Same — `terminalManager.listSummaries()` → store
- `disposeWorkspace()` (line 272): `terminalManager.markInterruptedAndStopAll()` stays — this is a process operation. The manager internally delegates the summary part to the store.

**Decision**: Expose store as `manager.store` (public readonly). This is the simplest path — avoids duplicating the workspace→store registry. Callers that only need summaries can type their dependency as `{ store: SessionSummaryStore }`.

#### 2. `src/server/runtime-state-hub.ts`

**File**: `src/server/runtime-state-hub.ts`
**Changes**:
- `trackTerminalManager()` (line 469): Change `manager.onSummary(...)` → `manager.store.onChange(...)`
- The `RuntimeStateHub` interface's `trackTerminalManager` method signature stays the same (takes a `TerminalSessionManager`) since the hub accesses `.store` internally.

#### 3. `src/trpc/workspace-api.ts`

**File**: `src/trpc/workspace-api.ts`
**Changes**:
- `saveState` handler (line 486): Change `terminalManager.listSummaries()` → `terminalManager.store.listSummaries()`
- `loadChanges` handler (line 307): Change `terminalManager.getSummary()` → `terminalManager.store.getSummary()`
- `setTaskDisplaySummary` handler (line 575): Change `manager.setDisplaySummary()` → `manager.store.setDisplaySummary()`
- `CreateWorkspaceApiDependencies` type doesn't change — it takes `TerminalSessionManager` and callers access `.store`.

#### 4. `src/trpc/hooks-api.ts`

**File**: `src/trpc/hooks-api.ts`
**Changes**:
- `applyConversationSummaryFromMetadata()` (line 23): Change parameter type from `TerminalSessionManager` to `SessionSummaryStore`. Update calls: `manager.appendConversationSummary()` → `store.appendConversationSummary()`, `manager.setDisplaySummary()` → `store.setDisplaySummary()`
- `ingest` handler: Get the store from the manager:
  ```typescript
  const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
  const store = manager.store;
  ```
  Then change all summary calls:
  - `manager.getSummary(taskId)` → `store.getSummary(taskId)` (line 97)
  - `manager.applyHookActivity(taskId, ...)` → `store.applyHookActivity(taskId, ...)` (lines 138, 162)
  - `manager.transitionToReview(taskId, "hook")` → `store.transitionToReview(taskId, "hook")` (line 147)
  - `manager.transitionToRunning(taskId)` → `store.transitionToRunning(taskId)` (line 147)
  - `manager.applyTurnCheckpoint(taskId, checkpoint)` → `store.applyTurnCheckpoint(taskId, checkpoint)` (line 177)

#### 5. `src/trpc/runtime-api.ts`

**File**: `src/trpc/runtime-api.ts`
**Changes**:
- `startTaskSession` handler (line 158): `terminalManager.getSummary(body.taskId)` → `terminalManager.store.getSummary(body.taskId)` — reads previous agent ID for resume
- `startTaskSession` handler (line 203): `terminalManager.applyTurnCheckpoint(...)` → `terminalManager.store.applyTurnCheckpoint(...)`
- `migrateTaskWorkingDirectory` handler (line 395): `terminalManager.getSummary(input.taskId)` → `terminalManager.store.getSummary(input.taskId)`

#### 6. `src/server/shutdown-coordinator.ts`

**File**: `src/server/shutdown-coordinator.ts`
**Changes**:
- `collectShutdownInterruptedTaskIds()` (line 129): Change parameter from `TerminalSessionManager` to `SessionSummaryStore`. Change `terminalManager.listSummaries()` → `store.listSummaries()`.
- `shutdownRuntimeServer()` (line 161): Access store from manager:
  ```typescript
  const { store } = terminalManager;
  terminalManager.stopReconciliation(); // process operation
  const interrupted = terminalManager.markInterruptedAndStopAll(); // process + summary
  const interruptedTaskIds = collectShutdownInterruptedTaskIds(interrupted, store);
  ```
- `resolveSummary` callback (line 178): `terminalManager.getSummary(taskId)` → `store.getSummary(taskId)`

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] All tests pass: `npm run test`
- [ ] Web UI type checks: `npm run web:typecheck`

#### Manual

- [ ] grep for `terminalManager.getSummary`, `terminalManager.listSummaries`, `terminalManager.onSummary`, `terminalManager.applyHookActivity`, etc. — should find zero hits outside session-manager.ts
- [ ] grep for `TerminalSessionManager` in trpc/ and server/ — should only appear in type imports for process operations, not for summary access

**Checkpoint**: All external callers use the store. The decoupling is complete at the code level.

---

## Phase 4: Tests + cleanup

### Overview

Update existing test suites to work with the new store injection, add focused unit tests for `InMemorySessionSummaryStore`, and clean up any dead code.

### Changes Required

#### 1. Update existing session-manager tests

**File**: `test/runtime/terminal/session-manager.test.ts`
**Changes**:
- Every `new TerminalSessionManager()` call becomes `new TerminalSessionManager(new InMemorySessionSummaryStore())`
- Tests that call `manager.hydrateFromRecord()` change to `manager.store.hydrateFromRecord()`
- Tests that call `manager.applyHookActivity()` change to `manager.store.applyHookActivity()`
- Tests that call `manager.getSummary()` change to `manager.store.getSummary()`
- Tests that test `applySessionEvent` directly (line 40-48) may need adjustment since the method moves to the store — verify the test still reaches the right code path.

**File**: `test/runtime/terminal/session-manager-auto-restart.test.ts`
**Changes**: Same pattern — inject store, update API calls.

**File**: `test/runtime/terminal/session-manager-interrupt-recovery.test.ts`
**Changes**: Same pattern.

**File**: `test/runtime/terminal/session-manager-reconciliation.test.ts`
**Changes**: Same pattern.

#### 2. New store unit tests

**File**: `test/runtime/terminal/session-summary-store.test.ts` (new)
**Changes**: Focused tests for the store in isolation:
- `hydrateFromRecord` populates entries
- `getSummary` returns cloned snapshots (mutation isolation)
- `listSummaries` returns all entries
- `ensureEntry` creates default summary
- `update` applies patches and emits
- `applySessionEvent` drives state machine transitions correctly
- `transitionToReview` / `transitionToRunning` — verify state changes and edge cases (wrong source state → no-op)
- `applyHookActivity` — isNewEvent clearing, carry-forward semantics, no-op on no changes
- `appendConversationSummary` — retention caps (5 entries, 2000 chars), LLM summary preservation
- `setDisplaySummary` — basic set + generatedAt
- `applyTurnCheckpoint` — dedup on same ref+commit, previous checkpoint rotation
- `markAllInterrupted` — marks specified task summaries
- `onChange` — listener receives cloned summaries, unsubscribe works
- `recoverStaleSession` — resets active-but-no-process entries to idle

#### 3. Clean up dead code

**File**: `src/terminal/session-manager.ts`
**Changes**:
- Remove the `cloneSummary()` helper if it's no longer used internally (it moves to the store)
- Remove the `createDefaultSummary()` helper (moves to store)
- Remove the `updateSummary()` helper (moves to store)
- Remove the `isActiveState()` helper if only used by moved methods (check: also used in `startTaskSession` line 327 and reconciliation — may stay)
- Remove the `emitSummary()` method (line 1342)
- Remove the `summaryListeners` Set (line 231)

#### 4. Update research doc

**File**: `docs/research/2026-04-10-session-summary-dual-sourcing.md`
**Changes**: Add a "Resolution" section noting that Option A (SessionSummaryStore extraction) was implemented, with a link to this plan and the implementing commit(s).

#### 5. Release hygiene

**File**: `docs/todo.md` — Remove item #17 and renumber.
**File**: `CHANGELOG.md` — Add entry under current version.
**File**: `docs/implementation-log.md` — Add detailed entry.

### Success Criteria

#### Automated

- [ ] All tests pass: `npm run test`
- [ ] Web UI tests pass: `npm run web:test`
- [ ] Full check passes: `npm run check`
- [ ] Build passes: `npm run build`

#### Manual

- [ ] Start dev server (`npm run dev:full`), create a task, start an agent session, verify terminal works, hook transitions work, review state shows correctly
- [ ] Verify session summaries persist across page reload (the save/load cycle through the store)
- [ ] Verify project task counts in the sidebar update correctly (workspace-registry reads from store)
- [ ] Verify graceful shutdown moves running tasks to trash (shutdown-coordinator reads from store)

---

## Risks

- **Test fixture churn**: 6 test files need constructor updates. Per AGENTS.md guidance on test fixtures, use a shared `createTestManager()` helper to minimize the blast radius.
- **Listener notification ordering**: Currently `emitSummary()` (global subscribers) and `listener.onState()` (per-session) happen in the same synchronous tick. After extraction, store `onChange` fires first (inside the mutation), then the manager notifies per-session listeners. This changes the relative ordering — verify no code depends on per-session listeners firing before or after global ones.
- **Reconciliation side effects**: `applyReconciliationAction` (line 1275) uses both `applySessionEvent` (→ store) and checks `entry.active` (→ manager). Make sure the store's `applySessionEvent` return value gives the manager enough information to handle process-side effects.

## References

- Research doc: `docs/research/2026-04-10-session-summary-dual-sourcing.md`
- Todo item: `docs/todo.md` #17
- Session state machine: `src/terminal/session-state-machine.ts`
- Session manager: `src/terminal/session-manager.ts`
- Terminal service interface: `src/terminal/terminal-session-service.ts`
- Existing tests: `test/runtime/terminal/session-manager*.test.ts`
