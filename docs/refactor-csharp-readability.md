# Readability Refactoring Roadmap

**Goal:** Make the codebase navigable in the way a well-structured C# solution is — ctrl+click through interfaces, see contracts at a glance, trace data flow without grep.

**Status:** Plan documented. No work started.
**Date:** 2026-04-14

---

## Context

The codebase's author is a C# developer. The current TypeScript code uses idiomatic JS/TS patterns (factory-closures, inline callbacks, anonymous arrow functions in object literals) that are hard to navigate compared to C#'s class-based, interface-driven, constructor-injected style. This document defines concrete refactors and library adoptions to close that gap.

The refactors are ordered by priority. Each is independent and can be done by a fresh agent in isolation.

---

## Table of Contents

1. [Libraries to adopt](#1-libraries-to-adopt)
2. [Explicit return types and named types](#2-explicit-return-types-and-named-types)
3. [IDisposable and DisposableStore](#3-idisposable-and-disposablestore)
4. [Convert RuntimeStateHub to a class](#4-convert-runtimestatehub-to-a-class)
5. [Convert RuntimeApi to a class and split into handler files](#5-convert-runtimeapi-to-a-class-and-split-into-handler-files)
6. [Shared service interfaces for dependency injection](#6-shared-service-interfaces-for-dependency-injection)
7. [Message factory functions and dispatch map](#7-message-factory-functions-and-dispatch-map)
8. [Split App.tsx into Context providers](#8-split-apptsx-into-context-providers)

**Dependency graph (do items above their dependencies first):**
```
1 (libraries)           — independent
2 (return types)        — independent
3 (IDisposable + store) — independent, but best done before 4-5
4 (StateHub class)      — benefits from 3 (can use _register pattern)
5 (RuntimeApi class)    — same pattern as 4
6 (service interfaces)  — requires 4 and 5 (need classes to implement interfaces)
7 (message factories)   — easier after 4 (refactored hub)
8 (App.tsx providers)   — independent of backend refactors
```

---

## 1. Libraries to Adopt

### 1a. `neverthrow` — typed Result types

**Problem:** Every handler in `runtime-api.ts` independently wraps itself in try/catch and constructs `{ ok: false, summary: null, error: message }`. The error type is always `string`, losing all structure. The pattern is copy-pasted across 6+ handlers.

**What it gives us:** `Result<T, E>` and `ResultAsync<T, E>` types with typed error variants and composable chaining (`.andThen()`, `.map()`). 4KB, zero dependencies.

**Install:**
```bash
npm install neverthrow
```

**Before (current pattern in `src/trpc/runtime-api.ts:116-223`):**
```typescript
startTaskSession: async (workspaceScope, input) => {
    try {
        // ... 90 lines of logic
        return { ok: true, summary: nextSummary };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, summary: null, error: message };
    }
},
```

**After:**
```typescript
import { ResultAsync, ok, err } from "neverthrow";

type StartSessionError =
    | { type: "no_agent"; message: string }
    | { type: "spawn_failed"; binary: string; cause: string }
    | { type: "workspace_missing"; taskId: string };

async startTaskSession(
    scope: RuntimeTrpcWorkspaceScope,
    input: unknown,
): ResultAsync<RuntimeTaskSessionSummary, StartSessionError> {
    const resolved = resolveAgentCommand(config);
    if (!resolved) return err({ type: "no_agent", message: "..." });

    const summary = await terminalManager.startTaskSession(request);
    return ok(summary);
}
```

**Where it applies:** Every handler in `src/trpc/runtime-api.ts` and `src/trpc/workspace-api.ts` that returns `{ ok: boolean; error?: string }`. Adopt incrementally — one function at a time. The tRPC output schemas will also need updating as handlers migrate.

**Docs:** https://github.com/supermacro/neverthrow

---

### 1b. `mitt` — typed event emitter

**Problem:** Cross-component communication uses ad-hoc `onChange(callback)` patterns with manual `Map<string, () => void>` unsubscribe tracking. IDE "Find All References" can't discover event wiring because subscribers are anonymous functions. Cleanup requires manually iterating Maps and calling each unsubscribe function.

**What it gives us:** Typed event contracts where "Find All References" on an event name shows every subscriber. 200 bytes, Map-backed.

**Install:**
```bash
npm install mitt
```

**Before (current pattern in `src/terminal/session-summary-store.ts`):**
```typescript
// Hand-rolled listener set
private readonly listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();

onChange(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
}

// Consumer in runtime-state-hub.ts — manual unsubscribe tracking
const unsubscribe = manager.store.onChange((summary) => {
    queueTaskSessionSummaryBroadcast(workspaceId, summary);
});
terminalSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
```

**After:**
```typescript
import mitt from "mitt";

type SessionStoreEvents = {
    summaryChanged: RuntimeTaskSessionSummary;
    sessionRecovered: { taskId: string };
    allInterrupted: string[];
};

class InMemorySessionSummaryStore {
    readonly events = mitt<SessionStoreEvents>();

    update(taskId: string, patch: Partial<RuntimeTaskSessionSummary>) {
        // ... apply patch
        this.events.emit("summaryChanged", summary);
    }
}

// Consumer — "Find All References" on 'summaryChanged' shows every subscriber
manager.store.events.on("summaryChanged", (summary) => {
    this.queueBroadcast(workspaceId, summary);
});
```

**Where it applies:**
- `src/terminal/session-summary-store.ts` — the hand-rolled `listeners` Set
- `src/server/runtime-state-hub.ts` — the `terminalSummaryUnsubscribeByWorkspaceId` Map
- Any future cross-component event wiring

**IDisposable integration (see section 3):** mitt's `emitter.on()` returns `void`, not `IDisposable`. When using the Disposable base class, wrap subscriptions for automatic cleanup:
```typescript
const handler = (summary: RuntimeTaskSessionSummary) => { ... };
emitter.on("summaryChanged", handler);
this._register(toDisposable(() => emitter.off("summaryChanged", handler)));
```

**Event naming convention:** Adopt VS Code's `onDid*` / `onWill*` naming for event properties:
- **`onDid*`** (past tense) — fires after something happened. Example: `onDidSummaryChange`, `onDidMetadataUpdate`
- **`onWill*`** (future tense) — fires before an action, allowing preparation or cancellation. Example: `onWillSessionStart`

This makes event purpose discoverable without reading docs. Apply during mitt conversion: the current `onChange` on `SessionSummaryStore` becomes `onDidSummaryChange`, the `onMetadataUpdated` callback becomes `onDidMetadataUpdate`, etc.

**Docs:** https://github.com/developit/mitt

---

## 2. Explicit Return Types and Named Types

**Problem:** Important functions rely on type inference — the return type is computed from the implementation, not declared. Utility type gymnastics like `NonNullable<ReturnType<typeof resolveAgentCommand>>` are used instead of named types. You can't ctrl+click to a type definition because the type doesn't have one.

**What to do:**

### 2a. Add explicit return types to all exported functions

Every exported function and public method should have an explicit return type annotation. This is purely additive — no behavior change.

**Before:**
```typescript
export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies) {
    // return type is inferred from the 480-line implementation
    return { trackTerminalManager, handleUpgrade, ... };
}
```

**After:**
```typescript
export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
    return { trackTerminalManager, handleUpgrade, ... };
}
```

**Enforcement:** Add a Biome or ESLint rule for explicit return types on exported functions. Check if Biome supports this natively; if not, use `@typescript-eslint/explicit-function-return-type` scoped to exports only.

### 2b. Replace utility type gymnastics with named types

**Before (in `src/trpc/runtime-api.ts:428-429`):**
```typescript
let resolved: NonNullable<ReturnType<typeof resolveAgentCommand>> | undefined;
let scopedRuntimeConfig: Awaited<ReturnType<typeof deps.loadScopedRuntimeConfig>> | undefined;
```

**After:**
```typescript
// In src/config/agent-registry.ts — export the type alongside the function
export type ResolvedAgentCommand = NonNullable<ReturnType<typeof resolveAgentCommand>>;

// In usage site — navigable via "Go to Definition"
let resolved: ResolvedAgentCommand | undefined;
```

**Where to look:** Grep for `ReturnType<typeof` across the codebase. Each occurrence is a candidate for a named export in the module that defines the function.

**Files likely affected:**
- `src/trpc/runtime-api.ts`
- `src/config/agent-registry.ts`
- `src/terminal/session-manager.ts`
- `src/terminal/session-reconciliation-sweep.ts`

---

## 3. IDisposable and DisposableStore

**Problem:** The codebase has no standard lifecycle contract. Every service manages cleanup differently — manual Map iteration, duplicated if/null/clearInterval blocks, leaked subscriptions. When classes are introduced (sections 4-5), this problem doesn't go away — manual cleanup just moves from function bodies to method bodies unless there's a composable cleanup primitive.

### The cleanup mess today

**`runtime-state-hub.ts:514-551` — 8 separate manual cleanup operations in `close()`:**
```typescript
close: async () => {
    unsubscribeDebugLog();                                          // 1. debug log subscription
    if (debugLogBroadcastTimer) { clearTimeout(debugLogBroadcastTimer); }  // 2. debug timer
    pendingDebugLogEntries.length = 0;                              // 3. debug buffer
    for (const timer of taskSessionBroadcastTimersByWorkspaceId.values()) {
        clearTimeout(timer);                                        // 4. broadcast timers
    }
    taskSessionBroadcastTimersByWorkspaceId.clear();                // 5. timer map
    pendingTaskSessionSummariesByWorkspaceId.clear();               // 6. pending map
    for (const unsub of terminalSummaryUnsubscribeByWorkspaceId.values()) {
        try { unsub(); } catch { }                                  // 7. store subscriptions
    }
    terminalSummaryUnsubscribeByWorkspaceId.clear();
    workspaceMetadataMonitor.close();                               // 8. monitor
    // ... websocket cleanup
},
```

**`workspace-metadata-monitor.ts:73-90` — identical if/null/clearInterval repeated 4 times:**
```typescript
const stopAllTimers = (entry: WorkspaceMetadataEntry) => {
    if (entry.homeTimer) { clearInterval(entry.homeTimer); entry.homeTimer = null; }
    if (entry.focusedTaskTimer) { clearInterval(entry.focusedTaskTimer); entry.focusedTaskTimer = null; }
    if (entry.backgroundTaskTimer) { clearInterval(entry.backgroundTaskTimer); entry.backgroundTaskTimer = null; }
    if (entry.remoteFetchTimer) { clearInterval(entry.remoteFetchTimer); entry.remoteFetchTimer = null; }
};
```

**`session-manager.ts:115` — leaked subscription:**
```typescript
constructor(store: SessionSummaryStore) {
    this.store = store;
    // This subscription's unsubscribe function is discarded — never cleaned up
    this.store.onChange((summary) => { ... });
}
```

**`terminal-state-mirror.ts:100` — has `dispose()` but no shared interface:**
```typescript
dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
}
```

### What to do: create `src/core/disposable.ts`

Write ~80 lines of utility code. No npm dependency — this is too small and fundamental to outsource.

```typescript
// src/core/disposable.ts

/**
 * Universal cleanup contract — equivalent to C#'s System.IDisposable.
 * Every resource that needs cleanup implements this interface.
 */
export interface IDisposable {
    dispose(): void;
}

/** Wraps any cleanup function as an IDisposable. */
export function toDisposable(dispose: () => void): IDisposable {
    let disposed = false;
    return {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            dispose();
        },
    };
}

/**
 * Collects multiple IDisposable instances and disposes them all at once.
 * Equivalent to C#'s CompositeDisposable.
 */
export class DisposableStore implements IDisposable {
    private readonly items: IDisposable[] = [];
    private disposed = false;

    add<T extends IDisposable>(disposable: T): T {
        if (this.disposed) {
            disposable.dispose();
            return disposable;
        }
        this.items.push(disposable);
        return disposable;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        // Dispose in reverse order (LIFO) — matches C# convention
        for (const item of this.items.splice(0).reverse()) {
            try {
                item.dispose();
            } catch {
                // Swallow errors during cleanup — same as C# Dispose()
            }
        }
    }
}

/**
 * Base class for services that own disposable resources.
 * Subclasses call this._register() to track resources; all are
 * cleaned up automatically when dispose() is called.
 *
 * Equivalent to VS Code's Disposable base class.
 */
export abstract class Disposable implements IDisposable {
    private readonly store = new DisposableStore();

    protected _register<T extends IDisposable>(disposable: T): T {
        return this.store.add(disposable);
    }

    dispose(): void {
        this.store.dispose();
    }
}
```

### How it transforms cleanup code

**RuntimeStateHub (section 4) — before:**
```typescript
// 8 separate cleanup operations in close(), must remember every one
close: async () => {
    unsubscribeDebugLog();
    clearTimeout(debugLogBroadcastTimer);
    workspaceMetadataMonitor.close();
    // ... 5 more
}
```

**RuntimeStateHub (section 4) — after, with Disposable base class:**
```typescript
class RuntimeStateHub extends Disposable {
    constructor(deps: RuntimeStateHubDeps) {
        super();
        // Resources registered at creation time — cleanup is automatic
        this._register(toDisposable(onDebugLogEntry((entry) => { ... })));
        this._register(this.metadataMonitor);

        // Timers registered when created
        const timer = setTimeout(() => { ... }, BATCH_MS);
        this._register(toDisposable(() => clearTimeout(timer)));
    }

    // dispose() inherited from Disposable — cleans up everything registered
}
```

**workspace-metadata-monitor — before:**
```typescript
// 4 identical if/null/clearInterval blocks
if (entry.homeTimer) { clearInterval(entry.homeTimer); entry.homeTimer = null; }
if (entry.focusedTaskTimer) { clearInterval(entry.focusedTaskTimer); entry.focusedTaskTimer = null; }
// ...
```

**workspace-metadata-monitor — after:**
```typescript
// Each entry owns a DisposableStore for its timers
entry.timers = new DisposableStore();

const homeTimer = setInterval(() => refreshHome(workspaceId), intervalMs);
homeTimer.unref();
entry.timers.add(toDisposable(() => clearInterval(homeTimer)));

// Cleanup: one call
entry.timers.dispose();
```

**session-manager.ts — fixing the leaked subscription:**
```typescript
class TerminalSessionManager extends Disposable {
    constructor(store: SessionSummaryStore) {
        super();
        // Previously: return value discarded, subscription leaked
        // Now: registered for automatic cleanup
        this._register(toDisposable(this.store.onChange((summary) => { ... })));
    }
}
```

### Integration with mitt (section 1b)

mitt's `emitter.on()` returns `void`. Bridge to IDisposable with `toDisposable`:

```typescript
const handler = (summary: RuntimeTaskSessionSummary) => { ... };
emitter.on("summaryChanged", handler);
this._register(toDisposable(() => emitter.off("summaryChanged", handler)));
```

### Integration with existing `() => void` unsubscribe patterns

The codebase's existing `onChange()` methods return `() => void`. These map directly:

```typescript
// onChange returns () => void — wrap it
this._register(toDisposable(this.store.onChange((summary) => { ... })));
```

### Where it applies

| File | Current pattern | After |
|------|----------------|-------|
| `src/server/runtime-state-hub.ts` | 8 manual cleanup ops in `close()` | Class extends `Disposable`, resources `_register`ed at creation |
| `src/server/workspace-metadata-monitor.ts` | 4 identical if/null/clearInterval blocks | `DisposableStore` per entry for timers |
| `src/terminal/session-manager.ts` | Store `onChange` return value discarded (leak) | `_register(toDisposable(...))` in constructor |
| `src/terminal/terminal-state-mirror.ts` | Has `dispose()` but no shared interface | Add `implements IDisposable` |
| `src/terminal/ws-server.ts` | `IoOutputState.dispose()`, `detachControlListener` | Implement `IDisposable` |

### File changes

- `src/core/disposable.ts` — **new file**, ~80 lines
- No other files change in this section — adoption happens in sections 4-5 when classes are created

### What NOT to do

- Don't retrofit every file at once. Create the utility, then use it naturally as classes are converted in sections 4-5.
- Don't add VS Code's `MutableDisposable` or `DisposableMap` — start with the three core primitives (`IDisposable`, `toDisposable`, `DisposableStore` + `Disposable` base class). Add more if needed.
- Don't add leak tracking or debug assertions yet — keep it simple.

---

## 4. Convert RuntimeStateHub to a Class

**Problem:** `src/server/runtime-state-hub.ts` is the central nervous system of the app — a 552-line factory function that returns an object literal. Its state is 7 `Map`s, 2 timers, and a `Set`, all captured as closure variables. Methods are anonymous `const` declarations. There's no `this.` prefix to distinguish instance state from locals. The WebSocket `on("connection")` handler is 130 lines at 7 levels of nesting depth.

**What to do:** Convert `createRuntimeStateHub()` into `class RuntimeStateHub`.

### Current structure (factory-closure)

```
createRuntimeStateHub(deps)           — 552-line factory function
  7 Maps + 1 Set as closure variables — invisible state
  12 inner const functions             — anonymous, not navigable
  on("connection", async (client) =>  — 130-line nested handler, 7 levels deep
    try { try { if { if { ... } } } }
  )
  return { ... }                       — methods listed at end, disconnected from implementation
```

### Target structure (class)

```typescript
export class RuntimeStateHub {
    // Fields visible in class outline, like C# private readonly
    private readonly clientsByWorkspace = new Map<string, Set<WebSocket>>();
    private readonly clientToWorkspace = new Map<WebSocket, string>();
    private readonly allClients = new Set<WebSocket>();
    private readonly pendingSummaries = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
    private readonly broadcastTimers = new Map<string, NodeJS.Timeout>();
    private readonly summaryUnsubscribes = new Map<string, () => void>();
    private readonly resumeAttempted = new Set<string>();
    private readonly wss: WebSocketServer;
    private readonly metadataMonitor: WorkspaceMetadataMonitor;

    constructor(private readonly deps: RuntimeStateHubDeps) {
        this.wss = new WebSocketServer({ noServer: true });
        this.metadataMonitor = createWorkspaceMetadataMonitor({
            onMetadataUpdated: (id, metadata) => this.broadcastToWorkspace(id, {
                type: "workspace_metadata_updated",
                workspaceId: id,
                workspaceMetadata: metadata,
            }),
        });
        this.wss.on("connection", (client, ctx) => this.handleConnection(client, ctx));
    }

    // --- Public API (explicit, navigable) ---

    trackTerminalManager(workspaceId: string, manager: TerminalSessionManager): void { ... }
    handleUpgrade(request: IncomingMessage, socket: ..., head: Buffer, context: ...): void { ... }
    disposeWorkspace(workspaceId: string, options?: DisposeOptions): void { ... }
    async broadcastWorkspaceStateUpdated(workspaceId: string, workspacePath: string): Promise<void> { ... }
    async broadcastProjectsUpdated(preferredProjectId: string | null): Promise<void> { ... }
    broadcastTaskReadyForReview(workspaceId: string, taskId: string): void { ... }
    broadcastTaskTitleUpdated(workspaceId: string, taskId: string, title: string, opts?: ...): void { ... }
    async close(): Promise<void> { ... }

    // --- Private helpers (named methods, max nesting depth 2) ---

    private async handleConnection(client: WebSocket, context: unknown): Promise<void> {
        client.on("close", () => this.cleanupClient(client));
        const workspaceId = this.parseWorkspaceId(context);
        const workspace = await this.resolveWorkspace(workspaceId);
        if (!this.isClientReady(client)) return;

        this.registerClient(client, workspace);
        await this.sendInitialSnapshot(client, workspace);
        if (!this.isClientReady(client)) return;

        await this.connectMetadataMonitor(client, workspace);
        this.sendDebugState(client);
        this.sendWorkspaceErrors(client, workspace);
        await this.resumeInterruptedSessions(workspace);
    }

    private parseWorkspaceId(context: unknown): string | null { ... }
    private async resolveWorkspace(id: string | null): Promise<ResolvedWorkspaceStreamTarget> { ... }
    private isClientReady(client: WebSocket): boolean { ... }
    private registerClient(client: WebSocket, workspace: ResolvedWorkspaceStreamTarget): void { ... }
    private async sendInitialSnapshot(client: WebSocket, workspace: ResolvedWorkspaceStreamTarget): Promise<void> { ... }
    private async connectMetadataMonitor(client: WebSocket, workspace: ResolvedWorkspaceStreamTarget): Promise<void> { ... }
    private sendDebugState(client: WebSocket): void { ... }
    private sendWorkspaceErrors(client: WebSocket, workspace: ResolvedWorkspaceStreamTarget): void { ... }
    private async resumeInterruptedSessions(workspace: ResolvedWorkspaceStreamTarget): Promise<void> { ... }
    private send(client: WebSocket, message: RuntimeStateStreamMessage): void { ... }
    private broadcastToWorkspace(workspaceId: string, message: RuntimeStateStreamMessage): void { ... }
    private broadcastToAll(message: RuntimeStateStreamMessage): void { ... }
    private cleanupClient(client: WebSocket): void { ... }
    private queueSummaryBroadcast(workspaceId: string, summary: RuntimeTaskSessionSummary): void { ... }
    private flushSummaries(workspaceId: string): void { ... }
}
```

### Key changes

1. **Closure variables become private fields** — visible in IDE class outline
2. **Anonymous consts become named methods** — navigable via "Go to Definition"
3. **`on("connection")` handler (130 lines, 7 levels) becomes a pipeline of named private methods** — max depth 2
4. **`this.` prefix distinguishes instance state from locals** — no more guessing
5. **The `RuntimeStateHub` interface already exists** (lines 43-69) — the class `implements` it
6. **If section 3 (IDisposable) is done first**, the class extends `Disposable` and the `close()` method's 8 manual cleanup operations become `_register()` calls at construction time. If section 3 is not done yet, manual cleanup moves to the class's `close()` method as-is and can be retrofitted later.

### Further refinement: colocate workspace Maps

The 6 flat Maps keyed by `workspaceId` (lines 72-78) can be consolidated into a single typed object per workspace. This transforms `disposeWorkspace()` from 5 separate Map lookups into one context disposal.

**Before (6 separate Maps):**
```typescript
const terminalSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
const pendingTaskSessionSummariesByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
const taskSessionBroadcastTimersByWorkspaceId = new Map<string, NodeJS.Timeout>();
const runtimeStateClientsByWorkspaceId = new Map<string, Set<WebSocket>>();
const runtimeStateClients = new Set<WebSocket>();
const runtimeStateWorkspaceIdByClient = new Map<WebSocket, string>();
```

**After (one Map of typed contexts):**
```typescript
interface WorkspaceClientContext {
    clients: Set<WebSocket>;
    summaryUnsubscribe: IDisposable | null;
    pendingSummaries: Map<string, RuntimeTaskSessionSummary>;
    broadcastTimer: NodeJS.Timeout | null;
}

private readonly workspaces = new Map<string, WorkspaceClientContext>();
private readonly allClients = new Set<WebSocket>();
private readonly clientToWorkspace = new Map<WebSocket, string>();
```

This is optional and can be done during or after the main class conversion. It reduces the number of data structures from 6 to 3, and makes the per-workspace lifecycle obvious: create a `WorkspaceClientContext` when a workspace is tracked, dispose it when the workspace is removed.

### File changes

- `src/server/runtime-state-hub.ts` — rewrite from factory to class
- `src/server/create-runtime-server.ts` (or wherever `createRuntimeStateHub` is called) — change to `new RuntimeStateHub(deps)`
- Tests that mock or create the hub — update construction

### What NOT to change

- The `RuntimeStateHub` interface (lines 43-69) stays as-is — it's the public contract
- The `CreateRuntimeStateHubDependencies` interface stays — it becomes the constructor parameter type
- No behavior changes — same Maps, same timers, same broadcast logic

---

## 5. Convert RuntimeApi to a Class and Split into Handler Files

**Problem:** `src/trpc/runtime-api.ts` is a 612-line factory function that returns an object literal with 11 handler methods. Each handler is an anonymous async arrow function. You can't "Go to Definition" on `ctx.runtimeApi.startTaskSession` because it resolves to a computed type. The file mixes 11 unrelated operations (config, sessions, shell, debug, file open, migration).

### Step 1: Convert to class

Same mechanical transformation as RuntimeStateHub (section 4). `createRuntimeApi(deps)` becomes `class RuntimeApi`.

### Step 2: Extract each handler into its own file

Create `src/trpc/handlers/` directory. Each operation gets its own file:

```
src/trpc/handlers/
  start-task-session.ts          (from lines 116-223)
  stop-task-session.ts           (from lines 224-243)
  send-task-session-input.ts     (from lines 244-269)
  start-shell-session.ts         (from lines 270-306)
  run-command.ts                 (from lines 307-318)
  load-config.ts                 (from lines 66-80)
  save-config.ts                 (from lines 81-115)
  set-debug-logging.ts           (from lines 319-323)
  flag-task-for-debug.ts         (from lines 324-344)
  reset-all-state.ts             (from lines 345-356)
  open-file.ts                   (from lines 357-367)
  migrate-task-working-dir.ts    (from lines 368-612)
```

### Handler file pattern

Each file follows a consistent structure:

```typescript
// src/trpc/handlers/start-task-session.ts

import type { Result } from "neverthrow";
// ... other imports

export interface StartTaskSessionDeps {
    loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
    getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
}

export type StartSessionError =
    | { type: "no_agent"; message: string }
    | { type: "spawn_failed"; binary: string; cause: string };

export async function handleStartTaskSession(
    scope: RuntimeTrpcWorkspaceScope,
    input: RuntimeTaskSessionStartRequest,
    deps: StartTaskSessionDeps,
): Promise<Result<RuntimeTaskSessionSummary, StartSessionError>> {
    // ... handler logic (was lines 116-223 of runtime-api.ts)
}
```

### RuntimeApi class becomes a thin dispatcher

```typescript
// src/trpc/runtime-api.ts — now ~80 lines
export class RuntimeApi {
    constructor(private readonly deps: RuntimeApiDeps) {}

    async startTaskSession(scope: RuntimeTrpcWorkspaceScope, input: unknown) {
        return handleStartTaskSession(scope, parseTaskSessionStartRequest(input), this.deps);
    }

    async stopTaskSession(scope: RuntimeTrpcWorkspaceScope, input: unknown) {
        return handleStopTaskSession(scope, parseTaskSessionStopRequest(input), this.deps);
    }

    // ... one-liner per operation
}
```

### File changes

- `src/trpc/runtime-api.ts` — rewrite from factory to thin class
- `src/trpc/handlers/` — new directory with 12 handler files
- `src/trpc/app-router.ts` — update `ctx.runtimeApi` construction
- Tests — update to test individual handlers directly

---

## 6. Shared Service Interfaces for Dependency Injection

**Problem:** Every service defines its own ad-hoc dependency interface, and the same capability is redeclared independently across 4-8 consumers with slightly different names and signatures. There's no shared vocabulary for "I need the terminal manager" or "I need to broadcast state."

### The duplication today

The same capability appears in different dependency interfaces under different names:

**"Get me a terminal manager":**
```
CreateRuntimeApiDependencies:       getScopedTerminalManager(scope) => Promise<TerminalSessionManager>
CreateWorkspaceApiDependencies:     ensureTerminalManagerForWorkspace(id, path) => Promise<TerminalSessionManager>
CreateHooksApiDependencies:         ensureTerminalManagerForWorkspace(id, path) => Promise<TerminalSessionManager>
CreateRuntimeServerDependencies:    ensureTerminalManagerForWorkspace(id, path) => Promise<TerminalSessionManager>
CreateWorkspaceRegistryDependencies: (owns it, returns it via method)
```

**"Broadcast workspace state updated":**
```
CreateRuntimeApiDependencies:       broadcastRuntimeWorkspaceStateUpdated(id, path) => Promise<void> | void
CreateWorkspaceApiDependencies:     broadcastRuntimeWorkspaceStateUpdated(id, path) => Promise<void> | void
CreateHooksApiDependencies:         broadcastRuntimeWorkspaceStateUpdated(id, path) => Promise<void> | void
```

**"Broadcast task title updated":**
```
CreateWorkspaceApiDependencies:     broadcastTaskTitleUpdated(wid, tid, title, opts)
RuntimeStateHub interface:          broadcastTaskTitleUpdated(wid, tid, title, opts)
```

**"Broadcast projects updated":**
```
CreateWorkspaceApiDependencies:     broadcastRuntimeProjectsUpdated(preferredId) => Promise<void> | void
RuntimeStateHub interface:          broadcastRuntimeProjectsUpdated(preferredId) => Promise<void>
```

Each consumer re-specifies the same function signature. When a signature changes, you update 4-8 interfaces. You can't ctrl+click to understand "where does this capability come from" because each declaration is independent.

### The fix: define shared service interfaces

In C#, each service has one interface defined once. Consumers depend on that interface. The dependency graph is visible by reading constructor signatures. Do the same here.

**New file: `src/core/service-interfaces.ts`**

```typescript
import type { RuntimeTaskSessionSummary } from "./api-contract";

/**
 * Provides access to terminal session managers per workspace.
 * Analogous to a scoped service in C# DI.
 */
export interface ITerminalManagerProvider {
    getTerminalManager(workspaceId: string): TerminalSessionManager | null;
    ensureTerminalManager(workspaceId: string, repoPath: string): Promise<TerminalSessionManager>;
}

/**
 * Broadcasts real-time state changes to connected browser clients.
 * Consumers use this instead of holding direct WebSocket references.
 */
export interface IRuntimeBroadcaster {
    broadcastWorkspaceStateUpdated(workspaceId: string, workspacePath: string): Promise<void>;
    broadcastProjectsUpdated(preferredCurrentProjectId: string | null): Promise<void>;
    broadcastTaskReadyForReview(workspaceId: string, taskId: string): void;
    broadcastTaskTitleUpdated(
        workspaceId: string,
        taskId: string,
        title: string,
        options?: { autoGenerated?: boolean },
    ): void;
}

/**
 * Loads and updates runtime configuration at global or workspace scope.
 */
export interface IRuntimeConfigProvider {
    getActiveConfig(): RuntimeConfigState;
    setActiveConfig(config: RuntimeConfigState): void;
    loadScopedConfig(workspaceId: string, workspacePath: string): Promise<RuntimeConfigState>;
}

/**
 * Resolves workspace identity and paths from workspace IDs.
 */
export interface IWorkspaceResolver {
    getActiveWorkspaceId(): string | null;
    getWorkspacePathById(workspaceId: string): string | null;
}
```

### How constructors change

**Before** — each service has its own bespoke dependency bag:

```typescript
export interface CreateHooksApiDependencies {
    getWorkspacePathById: (workspaceId: string) => string | null;
    ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
    broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
    broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
    captureTaskTurnCheckpoint?: (...) => Promise<RuntimeTaskTurnCheckpoint>;
    deleteTaskTurnCheckpointRef?: (...) => Promise<void>;
}
```

**After** — shared interfaces, readable at a glance:

```typescript
export class HooksApi {
    constructor(
        private readonly workspaces: IWorkspaceResolver,
        private readonly terminals: ITerminalManagerProvider,
        private readonly broadcaster: IRuntimeBroadcaster,
    ) {}
}
```

Now you read the constructor and immediately know: this service needs workspace resolution, terminal access, and broadcasting. You ctrl+click `ITerminalManagerProvider` and see every service that depends on it. You ctrl+click the interface definition and see exactly what methods it provides.

### How runtime-server.ts wiring changes

`runtime-server.ts` is where everything is constructed. Currently it builds per-consumer dependency bags by plucking functions from various objects. After shared interfaces, the wiring becomes:

```typescript
// Before — ad-hoc plucking for each consumer
const runtimeApi = createRuntimeApi({
    getActiveWorkspaceId: () => workspaceRegistry.getActiveWorkspaceId(),
    getScopedTerminalManager: async (scope) =>
        await deps.ensureTerminalManagerForWorkspace(scope.workspaceId, scope.workspacePath),
    broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
    // ... 8 more
});

// After — pass the service, not its methods
const runtimeApi = new RuntimeApi(workspaceRegistry, terminals, broadcaster, config);
const hooksApi = new HooksApi(workspaceRegistry, terminals, broadcaster);
const workspaceApi = new WorkspaceApi(terminals, broadcaster, config);
```

### Implementation order

1. Define the shared interfaces in `src/core/service-interfaces.ts`
2. Make `RuntimeStateHub` implement `IRuntimeBroadcaster` (it already provides all these methods)
3. Make `WorkspaceRegistry` implement `IWorkspaceResolver` and `ITerminalManagerProvider`
4. Update each service class constructor to accept the shared interfaces
5. Update `runtime-server.ts` wiring to pass service instances instead of function bags

**Important: this depends on sections 4 and 5.** The factory-closures must become classes first, because interfaces need something to implement them. Do sections 4-5, then this section makes the class constructors clean.

### Files affected

- `src/core/service-interfaces.ts` — new file, defines shared interfaces
- `src/server/runtime-state-hub.ts` — add `implements IRuntimeBroadcaster`
- `src/server/workspace-registry.ts` — add `implements IWorkspaceResolver, ITerminalManagerProvider`
- `src/trpc/runtime-api.ts` — constructor uses shared interfaces
- `src/trpc/hooks-api.ts` — constructor uses shared interfaces
- `src/trpc/workspace-api.ts` — constructor uses shared interfaces
- `src/trpc/projects-api.ts` — constructor uses shared interfaces
- `src/server/runtime-server.ts` — wiring simplified to pass service instances
- Delete or inline the per-consumer `Create*Dependencies` interfaces

---

## 7. Message Factory Functions and Dispatch Map

### 7a. Message factory functions

**Problem:** Object literals are constructed inline with spread operators and ternaries, making call sites hard to read:

```typescript
sendRuntimeStateMessage(client, {
    type: "debug_logging_state",
    enabled: debugEnabled,
    ...(debugEnabled ? { recentEntries: getRecentDebugLogEntries() } : undefined),
} satisfies RuntimeStateStreamDebugLoggingStateMessage);
```

**What to do:** Create one factory function per message type in a dedicated file.

**New file: `src/server/runtime-state-messages.ts`**

```typescript
export function buildDebugLoggingStateMessage(enabled: boolean): RuntimeStateStreamDebugLoggingStateMessage {
    return {
        type: "debug_logging_state",
        enabled,
        recentEntries: enabled ? getRecentDebugLogEntries() : undefined,
    };
}

export function buildSnapshotMessage(
    projectId: string | null,
    projects: RuntimeProjectSummary[],
    workspaceState: RuntimeWorkspaceStateResponse | null,
): RuntimeStateStreamSnapshotMessage {
    return {
        type: "snapshot",
        currentProjectId: projectId,
        projects,
        workspaceState,
        workspaceMetadata: null,
    };
}

// ... one per message type
```

**Call sites become one-liners:**
```typescript
this.send(client, buildDebugLoggingStateMessage(debugEnabled));
this.send(client, buildSnapshotMessage(projectId, projects, workspaceState));
```

**Where it applies:** Every `sendRuntimeStateMessage()` call in `src/server/runtime-state-hub.ts`.

### 7b. WebSocket message dispatch map

**Problem:** `web-ui/src/runtime/use-runtime-state-stream.ts:398-509` has a 110-line if/else chain that dispatches incoming WebSocket messages. Adding a new message type requires editing a long procedural block, and nothing enforces completeness.

**What to do:** Replace with a typed handler map.

**New file: `web-ui/src/runtime/runtime-stream-handlers.ts`**

```typescript
import type { RuntimeStateStreamMessage } from "@/runtime/types";

type StreamMessageHandler<T extends RuntimeStateStreamMessage["type"]> = (
    message: Extract<RuntimeStateStreamMessage, { type: T }>,
    state: RuntimeStateStreamStore,
    context: { activeWorkspaceId: string | null },
) => RuntimeStateStreamStore;

// Compiler enforces: every message type must have a handler
export const streamMessageHandlers: {
    [K in RuntimeStateStreamMessage["type"]]: StreamMessageHandler<K>;
} = {
    snapshot: (msg, state) => ({
        currentProjectId: msg.currentProjectId,
        projects: msg.projects,
        workspaceState: msg.workspaceState ? {
            ...msg.workspaceState,
            sessions: mergeTaskSessionSummaries(
                state.workspaceState?.sessions ?? {},
                Object.values(msg.workspaceState.sessions ?? {}),
            ),
        } : null,
        // ... rest of snapshot handling
    }),
    task_sessions_updated: (msg, state) => {
        if (!state.workspaceState) return state;
        return {
            ...state,
            workspaceState: {
                ...state.workspaceState,
                sessions: mergeTaskSessionSummaries(state.workspaceState.sessions, msg.summaries),
            },
        };
    },
    // ... one handler per message type
};
```

**Usage in `use-runtime-state-stream.ts`:**
```typescript
socket.onmessage = (event) => {
    const payload = JSON.parse(String(event.data)) as RuntimeStateStreamMessage;
    const handler = streamMessageHandlers[payload.type];
    if (handler) {
        dispatch({ type: "apply_message", message: payload });
    }
};
```

**The compiler guarantee:** Add a new message type to `RuntimeStateStreamMessage` and you get a type error in the handler map until you add the corresponding handler.

---

## 8. Split App.tsx into Context Providers

**Problem:** `web-ui/src/App.tsx` is 1,818 lines — a God component with 40+ hooks, 40+ callbacks, and all application state at the root. Every piece of state is prop-drilled through 55-prop interfaces (e.g., `CardDetailView` takes 55 props). The hook `useBoardInteractions` (384 lines, 15 input parameters, wires 8 sub-hooks) exists solely because all state lives in App.tsx.

**What to do:** Split into ~6 Context providers, each owning a slice of state. Components use `useContext()` to pull their own dependencies — no prop drilling.

### Target structure

```
AppProviders.tsx           — composes providers in correct order (~50 lines)
  ├── ProjectProvider      — project navigation, switching, config loading
  ├── BoardProvider        — board state, sessions, persistence, workspace sync
  ├── InteractionsProvider — drag/drop, trash workflow, task lifecycle
  ├── GitProvider          — branch actions, git history, sync, scope context
  ├── TerminalProvider     — terminal panels, connection readiness, resize
  └── DialogProvider       — all dialog open/close state (settings, debug, create, etc.)

AppShell.tsx               — just layout and JSX (~200 lines)
```

### Provider pattern

Each provider follows the same pattern:

```typescript
// web-ui/src/providers/board-provider.tsx

interface BoardContextValue {
    board: BoardData;
    setBoard: Dispatch<SetStateAction<BoardData>>;
    sessions: Record<string, RuntimeTaskSessionSummary>;
    upsertSession: (summary: RuntimeTaskSessionSummary) => void;
    canPersist: boolean;
}

const BoardContext = createContext<BoardContextValue | null>(null);

export function BoardProvider({ children }: { children: ReactNode }) {
    const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
    const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
    const [canPersist, setCanPersist] = useState(false);

    // ... persistence hook, workspace sync, session management

    const value = useMemo(() => ({
        board, setBoard, sessions, upsertSession, canPersist,
    }), [board, sessions, canPersist]);

    return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoardContext(): BoardContextValue {
    const ctx = useContext(BoardContext);
    if (!ctx) throw new Error("useBoardContext must be used within BoardProvider");
    return ctx;
}
```

### How existing state maps to providers

| Current location (App.tsx) | Target provider |
|---|---|
| `board`, `setBoard`, `sessions`, `setSessions`, `canPersistWorkspaceState` | `BoardProvider` |
| `currentProjectId`, `projects`, `workspaceState`, `streamError`, `isRuntimeDisconnected` | `ProjectProvider` |
| `selectedTaskId`, `selectedCard`, task start/stop/restart handlers | `InteractionsProvider` |
| Branch actions, git history, scope context, checkout dialogs | `GitProvider` |
| Terminal panel state, connection readiness, resize handlers | `TerminalProvider` |
| `isSettingsDialogOpen`, `isDebugDialogOpen`, `isCreateTaskDialogOpen`, etc. | `DialogProvider` |

### What disappears

Once providers exist:

1. **`CardDetailView`'s 55 props** drop to ~5 (just `selection` and view-specific layout props). Everything else comes from providers.
2. **`useBoardInteractions`** (384 lines, 15-param input) ceases to exist. Its sub-hooks read from `BoardProvider` and `InteractionsProvider` directly.
3. **Most `useCallback` definitions in App.tsx** move into the provider that owns the relevant state.
4. **App.tsx** becomes ~200 lines: import providers, compose them in `AppProviders`, render `AppShell`.

### Provider composition order

Order matters because some providers depend on others:

```typescript
// web-ui/src/providers/app-providers.tsx
export function AppProviders({ children }: { children: ReactNode }) {
    return (
        <ProjectProvider>
            <BoardProvider>
                <TerminalProvider>
                    <GitProvider>
                        <InteractionsProvider>
                            <DialogProvider>
                                {children}
                            </DialogProvider>
                        </InteractionsProvider>
                    </GitProvider>
                </TerminalProvider>
            </BoardProvider>
        </ProjectProvider>
    );
}
```

### Migration strategy

This is the largest refactor. Do it incrementally:

1. Start with `DialogProvider` — pure UI state, no cross-dependencies, lowest risk.
2. Then `ProjectProvider` — owns the WebSocket stream, project switching. Many hooks read from it.
3. Then `BoardProvider` — board state + sessions. `useBoardInteractions` sub-hooks can start reading from it.
4. Then `TerminalProvider` and `GitProvider` — these depend on board/project state being available.
5. Then `InteractionsProvider` — the wiring layer. At this point `useBoardInteractions` should be mostly hollow and can be deleted.
6. Finally, slim down App.tsx and CardDetailView props.

### File changes

New files:
- `web-ui/src/providers/project-provider.tsx`
- `web-ui/src/providers/board-provider.tsx`
- `web-ui/src/providers/interactions-provider.tsx`
- `web-ui/src/providers/git-provider.tsx`
- `web-ui/src/providers/terminal-provider.tsx`
- `web-ui/src/providers/dialog-provider.tsx`
- `web-ui/src/providers/app-providers.tsx`

Modified files:
- `web-ui/src/App.tsx` — gutted from 1,818 to ~200 lines
- `web-ui/src/components/card-detail-view.tsx` — props drop from 55 to ~5
- `web-ui/src/hooks/use-board-interactions.ts` — deleted or reduced to thin wrapper
- Any component that currently receives props from App.tsx — switch to `useXxxContext()` calls
- `web-ui/src/hooks/use-git-actions.ts` — moves into or reads from `GitProvider`
- `web-ui/src/hooks/use-terminal-panels.ts` — moves into or reads from `TerminalProvider`

---

## Libraries Evaluated and Skipped

| Library | What it does | Why skip |
|---|---|---|
| `awilix` / `tsyringe` / `inversify` | DI containers | Overkill for ~8 services. Converting closures to classes with constructor injection solves navigation without a container. |
| `Effect` (Effect-TS) | All-in-one typed effects (errors, DI, concurrency) | Paradigm shift — every function becomes an `Effect`. Learning curve too steep for the payoff. |
| NestJS | ASP.NET Core-like framework for TS | Framework, not a library. Would require rewriting the entire server layer. Too disruptive. |
| `@tshio/command-bus` | MediatR-like command/handler bus | Low adoption. Convention (one file per handler) achieves the same result without a dependency. |

---

## Priority Order

| Order | Task | Effort | What can go wrong | Dependencies |
|---|---|---|---|---|
| 1 | Explicit return types + named types (section 2) | Small, ongoing | **Nothing.** Purely additive annotations — no behavior change, no new code paths. | None |
| 2 | Install `neverthrow` + `mitt` (section 1) | Small, incremental | **Low.** New npm deps, but adopted one function at a time. If a handler's Result type is wrong, the compiler catches it. Risk is only in forgetting to update tRPC output schemas when migrating a handler. | None |
| 3 | IDisposable + DisposableStore (section 3) | Small (~80 lines, one file) | **Nothing.** New utility file with no consumers until sections 4-5 adopt it. No existing code changes. | None, but best before 4-5 |
| 4 | Convert `RuntimeStateHub` to class (section 4) | Medium (half-day) | **Moderate.** This is the central WebSocket hub — every browser connection flows through it. A bug here breaks the live UI for all tasks. Mitigated by: no behavior change (same Maps, same timers, same logic), existing integration tests (`runtime-state-stream.integration.test.ts`), and the `RuntimeStateHub` interface already defines the public contract. Test thoroughly by running the UI and verifying: project switching, task start/stop, session state sync, and multi-tab behavior. | Benefits from 3 |
| 5 | Convert `RuntimeApi` to class + split handlers (section 5) | Medium (half-day) | **Low-moderate.** Each handler is self-contained. Splitting into files is mechanical — the risk is in the tRPC router wiring (`app-router.ts`). If a handler is wired wrong, the specific operation breaks but others are unaffected. Test each operation: start/stop session, config save, shell session, migrate working directory. | Same pattern as 4 |
| 6 | Shared service interfaces (section 6) | Medium | **Low.** Renaming dependency parameters and adding `implements` clauses. The compiler enforces correctness — if a class doesn't implement the interface fully, it won't compile. Risk is only in `runtime-server.ts` wiring: if a service gets the wrong dependency injected, the wrong workspace or terminal manager could be used. Test by running the full app and verifying cross-workspace operations. | Requires 4 and 5 |
| 7 | Message factories + dispatch map (section 7) | Small | **Nothing.** Extracting inline objects into named functions. The dispatch map is additive — the compiler enforces every message type has a handler. | Easier after 4 |
| 8 | Split App.tsx into providers (section 8) | Large (~2-3 days) | **Highest risk in the set.** React Context re-render behavior is subtle — a provider that updates too broadly causes performance regressions across the entire UI. State that was synchronous (prop drilling) becomes asynchronous (context subscription), which can introduce render-order bugs. Must test every user flow: task create/edit/start/stop/trash/restore, drag-and-drop, project switching, git operations, terminal panels, all dialogs. Do incrementally — one provider at a time, starting with the lowest-risk (DialogProvider). | Independent of backend |

### Recommended execution phases

**Phase 1 — Zero-risk foundation (items 1-3).** Do alongside normal feature work. No behavior changes, no existing code modified. Creates the infrastructure that later phases build on.

**Phase 2 — Backend class conversions (items 4-5).** Focused refactoring sessions. These are the highest-value changes for backend navigability. Test with the full UI running — they touch the real-time data path.

**Phase 3 — Backend polish (items 6-7).** Makes the class conversions feel complete. Service interfaces make the dependency graph visible; message factories clean up the call sites. Lower risk because the hard structural work is done.

**Phase 4 — Frontend (item 8).** The big project. Do it last because it's the highest risk and most time-consuming, but also the biggest payoff for frontend navigability. The backend refactors are completely independent — don't wait for this to start them.

**Phase 5 — Additional class conversions (future).** Four more stateful modules that would benefit from the same factory→class+Disposable treatment applied in phase 2. Not scoped into the original roadmap because the navigability ROI is lower than the core hub/api conversions, but they carry real cleanup debt:

- `src/server/workspace-registry.ts` — owns worktree lifecycle, has 6+ Maps of per-workspace state
- `src/server/workspace-metadata-monitor.ts` — timers, polling, the 4× identical `if/null/clearInterval` pattern
- `src/terminal/session-manager.ts` — owns the store `onChange` subscription that currently leaks (return value discarded)
- `src/terminal/session-reconciliation-sweep.ts` — timer + state tracking, would benefit from `_register()` cleanup
