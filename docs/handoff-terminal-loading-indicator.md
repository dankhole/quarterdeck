# Handoff: Terminal Loading Indicator

## Branch State

Branch `refactor/terminal-slot-composition` is on `origin/main` with uncommitted changes. Before starting this work:

1. Commit the current refactoring changes (or merge main if needed first)
2. Read the refactored files to understand the new structure

## What Was Just Done

`terminal-slot.ts` (1,227 lines) was decomposed into 5 files using private helper class composition:

| File | Lines | Owns |
|------|-------|------|
| `terminal-slot.ts` | 749 | Orchestrator, subscribers, show/hide/park, lifecycle |
| `slot-socket-manager.ts` | 239 | IO + control WebSockets, `connectionReady`, `restoreCompleted` |
| `slot-renderer.ts` | 185 | WebGL, font readiness, DPR, canvas repair |
| `slot-resize-manager.ts` | 115 | Resize epoch dedup, ResizeObserver, debounce |
| `slot-write-queue.ts` | 65 | Serialized terminal.write() queue |

**Shared types moved** to avoid circular imports:
- `PersistentTerminalAppearance` -> `terminal-options.ts` (re-exported from `terminal-slot.ts`)
- `TERMINAL_SCROLLBACK` -> `terminal-constants.ts` (re-exported from `terminal-slot.ts`)

**Scroll races fixed:**
- Restore handler: reordered to `requestResize()` -> `scrollToBottom()` -> `ensureVisible()` (in `terminal-slot.ts` `handleRestore()`)
- ResizeObserver: immediate synchronous `fit()+scrollToBottom()` when `pendingScrollToBottom` armed, before debounce timer (in `slot-resize-manager.ts` `observe()`)

**Perf logging added** with `[perf]` prefix:
- Client: socket open, font ready, restore apply, show-to-interactive, connect-to-ready
- Server: `terminal-state-mirror.ts` getSnapshot(), `ws-server.ts` sendRestoreSnapshot()

**Zero consumer changes** - `terminal-pool.ts`, `use-persistent-terminal-session.ts`, `terminal-pool.test.ts` untouched.

## The New Task: Terminal Loading Indicator

### Problem
When a user selects a task, the terminal container is an empty div with a background color while the terminal is connecting/restoring. The terminal stays `visibility: hidden` until restore completes, which means the user sees nothing for 50-500ms (or longer on slow connections). For brand new tasks where the agent hasn't started, it could be even longer.

### Goal
Show a loading spinner/skeleton in the terminal container while the slot is warming up, then reveal the terminal once it's restored and scrolled correctly. Same treatment for new tasks where the agent process hasn't started yet.

### Key Files

**Where the terminal container lives:**
- `web-ui/src/components/detail-panels/agent-terminal-panel.tsx:239-249` — the `containerRef` div where the terminal gets mounted. Currently an empty div with `background: terminalBackgroundColor`. This is where a loading overlay would go.

**Where connection state is tracked:**
- `web-ui/src/terminal/use-persistent-terminal-session.ts` — the React hook that manages the terminal lifecycle. It already exposes `lastError` to the panel. Would need to expose a new `isConnecting` or `isRestoring` state derived from the slot's connection status.
- `web-ui/src/terminal/terminal-slot.ts:330-354` — `notifyConnectionReady()` fires when the terminal is fully restored and interactive. The `subscribe()` method (line 470) already delivers `onConnectionReady` callbacks.
- `web-ui/src/terminal/slot-socket-manager.ts` — owns `connectionReady` (false until restore completes) and `restoreCompleted` (false until restore snapshot applied). Both are public fields.

**Where visibility is controlled:**
- `terminal-slot.ts:347-350` — `ensureVisible()` sets `hostElement.style.visibility = "visible"`
- `terminal-slot.ts:485-487` — `show()` defers reveal when `sockets.restoreCompleted` is false
- `terminal-slot.ts:370-391` — `handleRestore()` calls `ensureVisible()` after restore + scroll + fit

### Suggested Approach

1. **Add `isLoading` state to `usePersistentTerminalSession`** — true from the moment a task is selected until `onConnectionReady` fires. This is already wired: the hook subscribes via `slot.subscribe({ onConnectionReady })`.

2. **Expose `isLoading` from the hook result** — add it to `UsePersistentTerminalSessionResult`.

3. **Render a loading overlay in `agent-terminal-panel.tsx`** — when `isLoading` is true, show a `<Spinner>` (from `@/components/ui/spinner`) centered in the terminal container div, on top of the background color. Use absolute positioning within the existing relative container.

4. **Handle "new task, no agent yet"** — the `summary?.state` prop on the panel tells you if the session is `"starting"` or `null`. Show the spinner for these states too. When the agent starts and the terminal connects, `onConnectionReady` fires and the spinner disappears.

5. **No crossfade needed** — the terminal is already `visibility: hidden` during restore, so the transition is: spinner visible -> spinner removed + terminal visibility:visible. Clean swap, no overlap.

### Relevant conventions
- Read `docs/web-ui-conventions.md` before frontend work
- Read `docs/ui-layout-architecture.md` before modifying panels
- Use `Spinner` from `@/components/ui/spinner` with appropriate size
- Use design tokens: `bg-surface-0` or inline `background` from props for spinner backdrop
- The `isVisible` prop on the panel already controls whether the terminal is rendered — loading indicator should respect this too

### Testing
- Select a task with an active agent — verify spinner appears briefly then terminal shows
- Start a new task — verify spinner shows until agent process starts and terminal connects
- Switch between tasks rapidly — verify no stale spinners or flickering
- Check `[perf]` logs in browser console to see timing
