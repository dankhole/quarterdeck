# Quarterdeck

A CLI-based quarterdeck board for orchestrating multiple AI coding agents (Claude, Codex) in parallel with isolated git worktrees, real-time terminal streaming, and a browser-based UI.

This is a personal fork of [kanban-org/kanban](https://github.com/kanban-org/kanban) that has been progressively diverging with significant new features and architectural changes. Much of the foundational work is from the upstream project.

## Quick reference

```bash
npm run install:all          # Install root + web-ui deps
npm run dev                  # Runtime server (watch mode, port 3500)
npm run dev:full             # Both runtime + web UI in one process
npm run web:dev              # Web UI dev server (Vite HMR, port 4173)
npm run build                # Full production build
npm run check                # Biome lint + typecheck + tests
npm run test                 # All runtime tests (vitest)
npm run test:fast            # Runtime + utility tests only
npm run test:integration     # Integration tests only
npm run web:test             # Web UI unit tests
npm run web:typecheck        # Typecheck web UI
npm run typecheck            # Typecheck runtime
npm run lint                 # Biome lint
npm run format               # Biome format + fix
npm run dogfood              # Build and launch against a target project
npm run link                 # Global CLI symlink for local dev
```

## Architecture

```
Browser (React + Vite, port 4173)
  │ tRPC + WebSocket
  ▼
Runtime Server (Node.js, port 3500)
  │ Spawns PTY processes
  ▼
Agent Processes (Claude, Codex, etc.)
  │ Each in isolated git worktree
  ▼
Hook Events (quarterdeck hooks ingest --event <to_review|to_in_progress>)
```

### Directory layout

```
src/                         # Runtime (Node.js TypeScript)
├── cli.ts                   # CLI entry point (Commander.js)
├── index.ts                 # Package export (api-contract only)
├── commands/                # CLI subcommands (hooks, task)
├── config/                  # Runtime configuration persistence
├── core/                    # Domain logic: API contracts, task mutations, shutdown
│   └── api-contract.ts      # Zod schemas for all runtime <-> browser types (primary type source)
├── fs/                      # File system locking utilities
├── projects/                # Project detection & discovery
├── prompts/                 # System prompt injection for agents
├── server/                  # HTTP server, runtime state hub, project registry
├── state/                   # Project state persistence (JSON in .quarterdeck/)
├── terminal/                # PTY sessions, agent registry, adapters, state machine
├── trpc/                    # tRPC API routers (runtime, project, projects, hooks)
└── workdir/                 # Worktree lifecycle, git sync, history, file changes

web-ui/                      # Frontend (React 18 + Vite + Tailwind v4)
├── src/
│   ├── App.tsx              # Root component
│   ├── components/          # React components (40+)
│   ├── hooks/               # Custom hooks (57 files)
│   ├── runtime/             # tRPC client, config queries, state streams
│   ├── state/               # Local board state (Immer-based reducer)
│   ├── stores/              # External store (project metadata, useSyncExternalStore)
│   ├── terminal/            # xterm.js wrapper, terminal panels
│   ├── styles/              # Tailwind CSS (globals.css with @theme tokens)
│   └── types/               # Type definitions
└── tests/                   # E2E tests (Playwright)

test/                        # Runtime test suites (Vitest)
├── integration/             # Startup flows, agent initialization
├── runtime/                 # Unit tests for core modules
└── utilities/               # Shared test helpers
```

### Key data flow

1. **Task creation**: UI hook -> tRPC `runtime.createCard` -> state persistence
2. **Task start**: UI hook -> tRPC `runtime.startSession` -> create worktree -> spawn agent PTY
3. **Agent activity**: Agent stdout -> PTY capture -> WebSocket stream -> xterm in browser
4. **State transitions**: Agent emits hook (`quarterdeck hooks ingest`) -> tRPC `hooks.ingest` -> guarded state machine transition -> WebSocket notify -> UI moves card
5. **Review**: Runtime serves git diff between base ref and worktree branch -> UI renders changes

### State management

- **Runtime**: `RuntimeStateHub` (WebSocket broadcast), `RuntimeProjectState` (JSON persistence in `.quarterdeck/projects/`)
- **Frontend board**: Custom Immer-based reducer (`web-ui/src/state/board-state.ts`), not Redux/Zustand
- **Frontend project metadata**: `useSyncExternalStore` pattern (`web-ui/src/stores/project-metadata-store.ts`)
- **Runtime-to-frontend sync**: tRPC subscriptions + WebSocket for terminal output

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+, TypeScript (ESM), Commander.js |
| API | tRPC v11 (type-safe RPC over HTTP/WebSocket) |
| Validation | Zod v4 (runtime schema validation at API boundaries) |
| Terminal | node-pty, @xterm/headless |
| Frontend | React 18, Vite 6, TypeScript |
| Styling | Tailwind CSS v4 (dark-only theme) |
| UI primitives | Radix UI (headless), custom components in `src/components/ui/` |
| Icons | Lucide React |
| Drag & drop | @hello-pangea/dnd |
| Toasts | Sonner |
| Linting/formatting | Biome (tabs, indent width 3, line width 120) |
| Testing | Vitest (runtime + web UI unit), Playwright (E2E) |
| Build | esbuild (runtime), Vite (web UI) |

## Development workflow

**Hot reload** requires two terminals:
1. `npm run dev` - runtime server on `http://127.0.0.1:3500`
2. `npm run web:dev` - Vite HMR on `http://127.0.0.1:4173` (proxies `/api/*` to runtime)

Use `http://127.0.0.1:4173` during development.

**VS Code F5 debugging**: `.vscode/launch.json` has "Dev Server" and "Run Tests" configs.

**Pre-commit hook** (Husky): runs `npm run test:precommit` (fast test suite).

**Before submitting**: `npm run check && npm run build`

## CI/CD

- **ci.yml**: Runs on push to main and PRs targeting main. Calls reusable `test.yml`.
- **test.yml**: Ubuntu (Node 20, 22) + macOS (Node 22). Build -> lint -> typecheck -> test -> web-ui test.
- **publish.yml**: Manual dispatch. Verifies tag, runs tests, publishes to npm via OIDC, creates GitHub Release, posts to Slack.

## Conventions and rules

@AGENTS.md

## Archive

`docs/archive/` contains old plans, investigations, and completed work. It is gitignored. **Do not read or reference anything in `docs/archive/` unless the user explicitly asks you to.**
