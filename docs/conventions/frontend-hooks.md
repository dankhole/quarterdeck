# Frontend Hooks and Context Patterns

**Purpose:** methodology guide for two related frontend patterns: extracting hook business logic into pure TypeScript domain modules, and keeping context/provider contracts explicit and navigable.

Read this when changing complex hooks, extracting domain logic, or changing provider/context return shapes. For the everyday `web-ui` stack, styling, UI primitives, and hook directory rules, use `docs/conventions/web-ui.md`.

Track remaining work in the primary checkout's local `docs/qDeck.yaml`. PRs and Git history record completed extractions; this document owns the current design contract and rationale.

---

## Table of Contents

1. [Pattern 1: Extract business logic from hooks into plain TS modules](#pattern-1-extract-business-logic-from-hooks-into-plain-ts-modules)
2. [Pattern 2: Named interfaces for context shapes](#pattern-2-named-interfaces-for-context-shapes)
3. [How the two patterns relate](#how-the-two-patterns-relate)

---

## Pattern 1: Extract business logic from hooks into plain TS modules

### The problem

React hooks blend two concerns into one function:

1. **Domain logic** — validation, state machines, data transforms, business rules. This is the equivalent of a C# service class.
2. **React wiring** — `useState`, `useEffect`, `useCallback`, `useRef`, context reads. This is the equivalent of a C# ViewModel or Controller that knows about the UI framework.

When these are tangled, you can't:
- Unit-test domain logic without React test utilities (`renderHook`, `act`)
- Read the business rules without mentally filtering out lifecycle noise
- Ctrl+click from a consumer to the actual logic (you land in a 400-line hook and have to search)
- Reuse the logic outside React (e.g. in a CLI tool, a migration script, a server-side validator)

### The pattern

Split one hook file into two files:

```
hooks/{domain}/use-foo-bar.ts    ← React hook (thin adapter)
hooks/{domain}/foo-bar.ts        ← Plain TS module (domain logic)
```

**The domain module** (`foo-bar.ts`):
- Zero React imports. No `useState`, `useEffect`, `useCallback`, `useContext`, `useRef`, no JSX.
- Exports pure functions and type definitions.
- Takes explicit parameters and returns explicit results. No implicit state.
- Fully testable with plain `describe`/`it` — no `renderHook`, no `act`, no component mounting.

**The hook** (`use-foo-bar.ts`):
- Reads state from React (contexts, props, refs).
- Calls domain functions with that state.
- Writes results back to React (setState, dispatch, ref mutation).
- Contains no business logic of its own — it's a wiring layer.

### How to identify candidates

An agent investigating which hooks to extract should follow this process:

#### Step 1: Find hooks with substantial domain logic

Scan all hook files (excluding tests). For each one, count the lines that do NOT reference React APIs. Specifically, look for:

- Functions or logic blocks inside `useCallback` bodies that could stand alone
- Complex conditional logic (validation, state machine transitions, error classification)
- Data transforms (mapping, filtering, building payloads)
- Multi-step orchestration (do A, check result, then do B or C)

**Required extraction:** When a hook contains more than 50 lines of non-React validation, transformation, or state-machine logic, extract that logic into a colocated pure TypeScript domain module and test it with plain `describe` / `it`. Below that threshold, extract when an independent domain rule benefits from direct testing; do not create a module just to move a few lines.

#### Step 2: Classify the domain logic

For each candidate, identify what category the extractable logic falls into:

| Category | What it looks like | Example |
|----------|-------------------|---------|
| **Validation** | "Can this action proceed? Why not?" | Checking if a task can be trashed, if a branch can be deleted |
| **State machine** | "Given current state + event, what's the next state?" | Conflict-resolution UI steps, form state transitions |
| **Data transform** | "Given raw data, produce a derived shape" | Building typed intent payloads, parsing server responses |
| **Decision planning** | "Given a result, which UI action comes next?" | Deriving an error presentation or a follow-up prompt |
| **Decision logic** | "Given these inputs, which path should we take?" | Selecting a conflict-resolution prompt or merge strategy |

This classification helps name the domain functions well. A validation function returns a result object with `canProceed` + `reason`. A decision function returns a plan or typed intent; the hook performs the UI effects. Managed task lifecycle effects belong to the server-owned service described in [session lifecycle](./session-lifecycle.md), including worktree creation, process launch, and durable board transitions.

#### Step 3: Draw the extraction boundary

For each candidate, identify:

1. **Inputs** — what data does the logic need? These become function parameters.
2. **Outputs** — what does the logic produce? These become the return type.
3. **Side effects** — does the logic need to call external things (tRPC mutations, toast notifications)? Keep these in the hook; pass their results into pure decisions when needed.

**Key rule:** The domain module must not import from React or from context providers. If it needs something that currently comes from a context, that value must be passed in as a parameter.

**Side effects stay in the hook.** The domain module can return a *description* of the side effect (e.g., `{ action: "show_toast", message: "..." }`), and the hook executes it. Or, more pragmatically, the hook calls the domain function for the decision and then does the side effect itself:

```typescript
// Domain module — pure validation (illustrative example)
export function validateTitle(title: string): string | null {
   return title.trim().length === 0 ? "Enter a title." : null;
}

// Hook — React wiring and side effects
const handleSave = useCallback(() => {
   const error = validateTitle(title);
   setValidationError(error);
   if (error !== null) return;
   onSave(title.trim());
}, [title, onSave]);
```

#### Step 4: Extract and verify

1. Create the domain module file. Move functions out of the hook, converting captured closure variables into explicit parameters.
2. Export explicit interface types for inputs and outputs where the shape isn't obvious from primitives.
3. Write plain TS unit tests for the domain module — these should be fast, no React, no mocking.
4. Update the hook to import from the domain module and call the extracted functions.
5. Verify the existing hook tests still pass (if any). They become integration tests.
6. Follow [`../testing.md`](../testing.md): run the focused domain and affected hook tests, then add web typecheck, the broader web suite, or a production build only when the changed boundary warrants them.

#### Step 5: Know when to stop

Not everything should be extracted. Leave a hook as-is when:

- It's mostly `useEffect` + `useState` with minimal logic (event listener setup, simple fetching)
- The "domain logic" is really just "call tRPC mutation and update state" — extracting that into a separate file adds indirection without adding testability
- The hook is <50 lines total
- The hook is a thin wrapper around a library (e.g., `useResizeDrag` wrapping pointer events)

The goal is not "every hook must have a companion module." The goal is "business logic is readable and testable without React."

### Migration strategy

Do NOT extract all hooks in a single pass. Two approaches:

1. **Opportunistic** (preferred): When modifying a hook for a feature or bugfix, check if it has extractable domain logic. If so, extract in the same PR.
2. **Focused pass**: Pick the 3-5 most complex hooks and extract them in a dedicated PR. Do this during a low-activity window to minimize merge conflicts.

---

## Pattern 2: Named interfaces for context shapes

### What it is

Every React context provider exposes its values through a typed interface:

```typescript
// providers/board-provider.tsx
export interface BoardContextValue {
   readonly board: BoardData;
   readonly selectedTaskId: string | null;
   readonly selectedCard: CardSelection | null;
   setBoard: Dispatch<SetStateAction<BoardData>>;
   setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
   // ... every field explicitly named and typed
}
```

Consumers use a typed hook:

```typescript
const { board, selectedCard, setSelectedTaskId } = useBoardContext();
```

### C# analogy

This is exactly `IBoardService` in a C# project. The interface is the contract. The provider is the implementation registered in DI. The `useXxxContext()` call is constructor injection. You can ctrl+click from `setSelectedTaskId` at the consumer → `BoardContextValue` interface → the provider that produces it.

### Granularity: split contexts at ownership boundaries

Providers should map to domain areas of the app, not individual operations. A valid split names different sources of truth or policy boundaries, such as project navigation, runtime stream ingress, persistence gating, or notification projection. Do not split state/actions for one domain merely to reduce field count.

[React re-renders context consumers when the provided value changes](https://react.dev/reference/react/useContext#caveats). A larger context can therefore invalidate consumers that need only one field; splitting can reduce those updates when values change independently. Neither a larger nor a smaller context is inherently faster. Evaluate value identity and actual consumer subscriptions before making a performance claim.

### Don't add a DI container library

Use context providers and typed `useXxxContext()` hooks for React-aware shared state. Adding a DI container or service locator would introduce a second discovery and ownership mechanism alongside those contracts. Pure services can use explicit function parameters and normal module composition without a container.

### Keep interfaces clean and explicit

1. **Every context value is a named, exported interface** — not an inline type, not `ReturnType<typeof useSomeHook>`. The interface lives in the provider file and is the source of truth.

2. **Interface fields have explicit types** — not `any`, not overly broad unions. If a function takes specific arguments, spell them out rather than using a generic callback type.

3. **Group fields by concern within the interface** — use comments to separate state fields, action callbacks, and derived values. This helps when scanning the interface to understand what a provider offers:

   ```typescript
   export interface GitContextValue {
      // State
      readonly isGitHistoryOpen: boolean;
      readonly runningGitAction: string | null;
      readonly gitHistory: GitHistoryData | null;

      // Actions
      runGitAction: (action: GitAction) => Promise<GitActionResult>;
      handleToggleGitHistory: () => void;
      switchHomeBranch: (branch: string) => Promise<void>;

      // Navigation
      navigateToFile: (path: string) => void;
      openGitCompare: (source: string, target: string) => void;
   }
   ```

4. **New fields go through the interface first** — when a component needs a new value from a provider, add it to the interface, implement it in the provider, then consume it. Don't reach around the interface by importing internal hooks from the provider file.

### Apply the interface pattern to non-provider state

The context interface pattern works for any shared state container, not just providers. If you have a store, a state machine, or a complex hook that returns an object, give it a named interface:

```typescript
// Before — anonymous return type, can't ctrl+click to see the shape
export function useTaskEditor(...) {
   return { editingTaskId, handleSave, handleCancel, ... };
}

// After — named interface, navigable
export interface UseTaskEditorResult {
   readonly editingTaskId: string | null;
   handleSave: () => Promise<void>;
   handleCancel: () => void;
   // ...
}

export function useTaskEditor(...): UseTaskEditorResult {
   // ...
}
```

Convention: any hook that returns an object with more than 3 fields gets a named result interface.

---

## How the two patterns relate

These patterns work together to create a three-layer architecture:

```
┌─────────────────────────────────────────────┐
│  Context Interfaces (BoardContextValue, etc) │  ← Contract layer
│  Named, exported, ctrl+clickable             │    Like C# interfaces
├─────────────────────────────────────────────┤
│  Domain Modules (task-lifecycle.ts, etc)      │  ← Logic layer
│  Pure TS, no React, testable without UI      │    Like C# service classes
├─────────────────────────────────────────────┤
│  Hooks (use-task-lifecycle.ts, etc)          │  ← Wiring layer
│  Thin React adapters that connect the above  │    Like C# controllers/VMs
└─────────────────────────────────────────────┘
```

A developer looking at a component sees:
1. `useBoardContext()` → ctrl+click → `BoardContextValue` interface → sees all available operations
2. `validateTrash(task, status)` → ctrl+click → `task-lifecycle.ts` → reads the pure logic
3. The hook is just the thin middle layer they can usually skip

This is the same navigability as a C# project: interface → service → consumer, with the UI framework details isolated in one layer.
