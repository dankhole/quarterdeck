# Test Coverage

Baseline captured 2026-04-08. Percentage breakdowns below are from that snapshot and are likely stale — significant refactoring has occurred since (session manager decomposition, 11 hooks extracted from App.tsx, code duplication cleanup, new modules like `src/core/api/`, `src/state/workspace-state-index.ts`, etc.). Re-run coverage to get current numbers.

The strategic guidance (prioritization, what-not-to-test, reusability for backend rewrite) remains current.

## Running coverage

```bash
# Runtime (src/)
npm test -- --coverage

# Web-UI (web-ui/src/)
cd web-ui && npx vitest run --coverage
```

Both generate three report formats:
- **text** — console table
- **html** — browsable at `coverage/index.html`
- **json-summary** — machine-readable for CI

`coverage/` directories are gitignored.

## Baseline (2026-04-08, likely stale)

| Suite | Statements | Branches | Functions | Lines | Tests |
|-------|-----------|----------|-----------|-------|-------|
| Runtime (`src/`) | 52.7% | 43.4% | 52.3% | 52.8% | 395 |
| Web-UI (`web-ui/src/`) | 35.8% | 30.3% | 33.6% | 35.7% | 320 |

As of 2026-04-13: 684 runtime tests across 63 test files, 56 web-ui test files.

## Coverage by module

### Runtime

| Module | Stmts | Branch | Funcs | Notes |
|--------|-------|--------|-------|-------|
| `src/title/` | 100% | 95% | 100% | Fully covered |
| `src/fs/` | 90% | 88% | 83% | Solid |
| `src/prompts/` | 84% | 78% | 100% | Solid |
| `src/state/` | 80% | 65% | 89% | Good |
| `src/core/` | 79% | 64% | 80% | Good |
| `src/terminal/` | 69% | 56% | 77% | Large module, mixed |
| `src/workspace/` | 61% | 46% | 62% | Mixed |
| `src/config/` | 83% | 69% | 92% | Good |
| `src/trpc/` | 40% | 37% | 24% | Weak — 2 of 5 routers untested |
| `src/server/` | 17% | 15% | 16% | Weakest — mostly 0% files |
| `src/commands/` | 34% | 28% | 30% | CLI handlers mostly untested |
| `src/projects/` | 0% | 0% | 0% | No tests |

### Web-UI

| Module | Stmts | Branch | Funcs | Notes |
|--------|-------|--------|-------|-------|
| `src/types/` | 100% | 100% | 100% | Type guards fully covered |
| `src/storage/` | 84% | 60% | 83% | Good |
| `src/state/` | 65% | 63% | 73% | Board state reducer well-tested |
| `src/hooks/` | 48% | 35% | 49% | 19/30 hooks have tests |
| `src/utils/` | 57% | 43% | 62% | 8/13 utilities have tests |
| `src/components/` | 31% | 26% | 29% | 14/47 components have tests |
| `src/runtime/` | 33% | 34% | 33% | Data layer mostly untested |
| `src/resize/` | 35% | 33% | 32% | 1/9 files tested |
| `src/stores/` | 38% | 25% | 47% | workspace-metadata-store untested |
| `src/terminal/` | 13% | 8% | 9% | persistent-terminal-manager at 1% |

## 0% coverage files (no tests at all, from 2026-04-08 baseline)

Note: Several files below have been decomposed since the baseline. `commands/task.ts` was split into `task-board-helpers.ts`, `task-lifecycle-handlers.ts`, `task-workspace.ts`. `trpc/app-router.ts` was split into `app-router-context.ts`, `app-router-init.ts`, `workspace-procedures.ts`. Coverage for decomposed modules may differ from the original monolithic files.

### Runtime

| File | Lines | Priority | Why |
|------|-------|----------|-----|
| `commands/task.ts` (+ extracted modules) | ~1068 total | High | CLI task subcommand — split into focused modules but likely still untested |
| `server/runtime-server.ts` | 218 | Medium | HTTP bootstrap; partially hit by integration tests |
| `server/runtime-state-hub.ts` | 432 | High | WebSocket broadcast hub — core data flow |
| `server/workspace-metadata-monitor.ts` (+ `workspace-metadata-loaders.ts`) | ~500 total | Medium | File watcher for workspace changes, decomposed |
| `server/workspace-registry.ts` | 376 | High | Workspace lifecycle management |
| `server/assets.ts` | 77 | Low | Static asset serving |
| `server/browser.ts` | 11 | Low | `open()` wrapper |
| `server/shell.ts` | 1 | Low | Re-export |
| `trpc/app-router.ts` (+ extracted modules) | ~476 total | Medium | Router composition + subscription handlers, decomposed |
| `trpc/projects-api.ts` | 168 | Medium | Only untested tRPC router |
| `workspace/get-workspace-changes.ts` | ~230 | High | Git diff generation — data correctness critical (reduced from 483 lines after refactor) |
| `workspace/initialize-repo.ts` | 40 | Low | One-time repo init |
| `workspace/read-workspace-file.ts` | 88 | Low | File reader utility |
| `terminal/terminal-session-service.ts` | Large | High | Session orchestrator — ties everything together |
| `projects/project-path.ts` | 7 | Low | Tiny utility |

### Web-UI

Note: 60 hook files now exist (up from ~30 at baseline). Many new hooks were extracted from `App.tsx` and `use-board-interactions.ts` — these are likely untested. New high-value targets include `use-task-start.ts`, `use-task-lifecycle.ts`, `use-trash-workflow.ts`, `use-session-column-sync.ts`, and `use-file-diff-content.ts`.

| File | Lines | Priority | Why |
|------|-------|----------|-----|
| `runtime/use-runtime-state-stream.ts` | 416 | High | Core data subscription — drives all live updates |
| `runtime/use-workspace-persistence.ts` | 144 | High | Board state persistence |
| `runtime/use-file-diff-content.ts` | 133 | Medium | On-demand diff loading (new) |
| `hooks/use-task-start.ts` | 251 | High | Task start orchestration (new, extracted from board interactions) |
| `hooks/use-task-lifecycle.ts` | 193 | High | Stop/restart/resume (new, extracted) |
| `hooks/use-trash-workflow.ts` | 383 | High | Trash/untrash/hard-delete (new, extracted) |
| `hooks/use-programmatic-card-moves.ts` | 183 | Medium | Automated card movement logic |
| `hooks/use-review-ready-notifications.ts` | 214 | Medium | Browser notification orchestration |
| `terminal/persistent-terminal-manager.ts` | ~400 | High | Terminal lifecycle (reduced from 805 after extraction of `terminal-registry.ts` and `terminal-socket-utils.ts`) |
| `terminal/terminal-registry.ts` | 137 | Medium | Terminal instance management (new) |
| `terminal/terminal-input.ts` | Medium | Medium | Paste-mode input handling |
| `stores/workspace-metadata-store.ts` | Large | Medium | External store for workspace data |
| Most `components/` without tests | Varies | Low | Presentation-heavy; 71 component files total now |

## How to improve coverage

### Prioritization strategy

Don't aim for 100% uniformly. Focus testing effort where bugs are expensive:

1. **Data correctness** — state mutations, git operations, persistence
2. **Orchestration logic** — session management, state machines, reconciliation
3. **API boundaries** — tRPC routers, hook handlers, WebSocket messages
4. **Business rules** — drag rules, access gates, notifications

Presentation components and thin wrappers are low priority.

### Highest-ROI targets

These files are large, complex, 0% covered, and on critical paths. Testing them would move the needle significantly.

#### Runtime — target: 70% overall

1. **`server/runtime-state-hub.ts`** (432 lines, 0%) — Test broadcast logic, subscription management, message routing. Mock WebSocket connections.

2. **`server/workspace-registry.ts`** (376 lines, 4%) — Test workspace create/delete/list lifecycle. Uses file system — use temp dirs like existing integration tests.

3. **`workspace/get-workspace-changes.ts`** (483 lines, 0%) — Test git diff generation with a real temp repo (same pattern as `task-worktree.test.ts`). Critical for review accuracy.

4. **`trpc/projects-api.ts`** (168 lines, 0%) — Follow the pattern in `hooks-api.test.ts` and `runtime-api.test.ts`. Straightforward to add.

5. **`commands/task.ts`** (1068 lines, 0%) — Large but mostly Commander.js wiring. Test the action handlers, not the CLI parsing. Extract testable functions if needed.

6. **`workspace/turn-checkpoints.ts`** (13% covered) — Checkpoint create/restore logic needs branch coverage.

7. **`terminal/terminal-session-service.ts`** (0%) — Session orchestration. Test the state coordination, mock the PTY layer.

#### Web-UI — target: 55% overall

1. **`terminal/persistent-terminal-manager.ts`** (805 lines, 1%) — The largest untested file. Test terminal instance lifecycle: create, attach, detach, dispose. Mock xterm.

2. **`runtime/use-runtime-state-stream.ts`** (416 lines, 1%) — Test subscription setup, message handling, reconnection. Mock the tRPC subscription.

3. **`runtime/use-workspace-persistence.ts`** (144 lines, 0%) — Test debounced save, conflict detection, retry logic.

4. **`hooks/use-programmatic-card-moves.ts`** (183 lines, 0%) — Test automated card movement decisions. Pure logic, easy to unit test.

5. **`hooks/use-review-ready-notifications.ts`** (214 lines, 0%) — Test notification triggers, permission checks, deduplication.

6. **`stores/workspace-metadata-store.ts`** (38%) — Improve coverage of the `useSyncExternalStore` pattern and cache invalidation.

7. **`state/board-state.ts`** (64%) — Already tested but has gaps in edge cases. Add tests for the uncovered action types in the reducer.

### Writing effective tests

#### Runtime tests

Runtime tests live in `test/` mirroring `src/` structure. Use existing patterns:

```bash
# Run a single test file during development
npx vitest run test/runtime/your-new-test.test.ts

# Watch mode for fast iteration
npx vitest test/runtime/your-new-test.test.ts
```

- **Temp directories**: Use `createTempDir()` from `test/utilities/temp-dir.test.ts` for filesystem tests.
- **Git repos**: See `test/runtime/git-history.test.ts` for setting up temp git repos.
- **Config mocking**: Use `createDefaultMockConfig()` from `test/utilities/runtime-config-factory.ts` to avoid fixture churn.
- **tRPC routers**: See `test/runtime/trpc/hooks-api.test.ts` for the pattern — create a caller with mocked context.

#### Web-UI tests

Web-UI tests are co-located with source files (`*.test.ts` / `*.test.tsx`):

```bash
# Run from web-ui directory
cd web-ui
npx vitest run src/hooks/your-hook.test.ts
npx vitest src/hooks/your-hook.test.ts  # watch mode
```

- **Hook testing**: Use `renderHook` from vitest + jsdom. See `src/hooks/use-board-interactions.test.tsx` for the pattern.
- **Component testing**: Use `render` + DOM queries. See `src/components/board-card.test.tsx`.
- **Mock tRPC**: Most hooks mock the tRPC client. See `src/runtime/use-runtime-config.test.tsx`.
- **Mock config**: Use `createMockRuntimeConfig()` from `src/test-utils/runtime-config-factory.ts`.

#### General tips

- **Test behavior, not implementation.** Assert on outputs and side effects, not internal state.
- **One test file per source file.** Keep the mapping 1:1 so coverage gaps are obvious.
- **Name tests as sentences.** `it("returns empty diff when worktree has no changes")` not `it("test diff")`.
- **Don't mock what you own** unless it's expensive (filesystem, network, PTY). Prefer testing through the real code path.
- **Branch coverage matters.** The gap between statement coverage (52%) and branch coverage (43%) means error paths and edge cases are under-tested. Write tests for the `else`, the `catch`, the early return.

### Milestone targets

| Milestone | Runtime | Web-UI | Focus |
|-----------|---------|--------|-------|
| Current | 53% stmts | 36% stmts | — |
| Next | 65% stmts | 45% stmts | 0% files on critical paths |
| Goal | 75% stmts | 60% stmts | Branch coverage parity |
| Stretch | 85% stmts | 70% stmts | Diminishing returns beyond this |

### What not to test

- **`src/server/browser.ts`** — 11-line `open()` wrapper. Testing it means mocking `open`. Not worth it.
- **`src/server/assets.ts`** — Static file serving. Validated by E2E tests.
- **`web-ui/src/components/ui/`** — Thin wrappers around Radix primitives. Test the components that use them instead.
- **`web-ui/src/main.tsx`** — App bootstrap. Covered by E2E smoke test.
- **Pure type files** (`types.ts`, `vite-env.d.ts`) — Nothing to test.
- **CSS/styling** — Validated visually, not via unit tests.

## Reusing the test suite against a non-TypeScript backend

If the runtime is ever rewritten in another language, some of the test suite transfers and some doesn't. The deciding factor is whether a test hits the server over a network boundary or directly imports TypeScript modules.

### Test coupling by layer

| Layer | Files | Tests | Reusable? | Why |
|-------|-------|-------|-----------|-----|
| **Integration tests** (`test/integration/`) | 6 | ~50 | **Yes** | Spawn a real server process, connect via HTTP and WebSocket, validate JSON responses |
| **tRPC API tests** (`test/runtime/trpc/`) | 3 | ~100 | **No** | Import router factory functions directly, mock internal TypeScript modules |
| **Unit tests — pure logic** (~10 files) | 10 | ~80 | **Partially** | Test pure functions like `addTaskToColumn()` — logic is portable but tests import TS directly |
| **Unit tests — services** (~30 files) | 30 | ~265 | **No** | Mock `child_process`, `fs`, internal modules — deeply TypeScript-coupled |
| **Web-UI tests** | 54 | 320 | **N/A** | Frontend tests are unaffected by backend language |

### What transfers cleanly

**Integration tests are already language-agnostic.** They:

- Spawn the server as a child process (`startQuarterdeckServer()`)
- Connect via `fetch()` and `new WebSocket()` — universal protocols
- Validate responses against JSON structure, not TypeScript types
- Don't import any internal modules

To reuse them, change the server binary being spawned and they work against Go, Rust, Python, etc. These become a **conformance test suite** for any backend implementation.

**Example from `runtime-state-stream.integration.test.ts`:**

```typescript
// Spawns actual process — could be any binary
const server = await startQuarterdeckServer({ cwd, homeDir, port });

// Connects over standard WebSocket
const stream = await connectRuntimeStream(`ws://127.0.0.1:${port}/api/runtime/ws`);

// Makes HTTP requests to tRPC endpoints
const response = await requestJson<RuntimeProjectsResponse>({
  baseUrl: `http://127.0.0.1:${port}`,
  procedure: "projects.list",
  type: "query",
});
```

### What doesn't transfer

**~90% of the test suite** directly imports TypeScript modules and mocks their internals:

```typescript
// tRPC test — imports router factory, mocks dependencies
import { createRuntimeApi } from "../../../src/trpc/runtime-api";
vi.mock("../../../src/terminal/agent-registry.js", () => ({ ... }));
const api = createRuntimeApi(createDeps(terminalManager));

// Service test — mocks Node.js built-ins
vi.mock("node:child_process", () => ({ execFile: mockImplementation }));
const result = await runGit("/repo", ["diff"]);
```

These test *implementation*, not *behavior through a boundary*. A new backend needs its own unit tests in its own language. That's expected and correct.

### The API contract as a language-neutral spec

`src/core/api-contract.ts` defines every request, response, and WebSocket message as Zod schemas. This is effectively a machine-readable API specification that can be converted to other formats:

- **JSON Schema** — auto-generate via `zod-to-json-schema`
- **OpenAPI/Swagger** — generate from JSON Schema for documentation and client codegen
- **Protocol Buffers / other IDLs** — manual translation from the Zod definitions

A new backend must satisfy the same contract: the same HTTP endpoints, the same WebSocket message shapes, the same state machine transitions. The integration tests then validate conformance.

### Practical path for a backend rewrite

1. **Expand integration tests first.** They're the only language-agnostic layer, and currently the smallest (6 files). Every critical behavior tested through HTTP/WebSocket today is a behavior you won't have to re-verify later. Priority areas to add integration coverage: workspace lifecycle, session start/stop, git diff serving, hook ingestion.

2. **Extract the API contract to JSON Schema.** Run `zod-to-json-schema` on the Zod schemas in `api-contract.ts`. This gives any language a spec to implement against without reading TypeScript.

3. **Write new unit tests in the target language.** The new backend will have its own internal structure — test those internals in whatever testing framework that language uses.

4. **Keep the integration tests in TypeScript.** They're a thin HTTP/WebSocket client. Maintaining them in TypeScript (where they already exist) is simpler than porting them. They become the cross-language conformance suite.
