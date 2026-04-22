This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

Agent instruction files
- `AGENTS.md` is the canonical repo-owned instructions file shared across agents.
- Keep shared agent instructions only in `AGENTS.md`. Do not maintain parallel instruction copies in `CLAUDE.md` or other agent-specific files.
- `CLAUDE.md` exists only as a minimal Claude Code compatibility shim: it should import `@AGENTS.md`, keep any Claude-only notes clearly marked, and stay intentionally tiny.
- Human-facing project overview, setup, architecture, and developer-guide content belongs in `README.md`, `DEVELOPMENT.md`, or `docs/`, not in `CLAUDE.md`.
- When updating the instruction-file bridge, run `npm run check:agent-instructions` (or `npm run check`) to catch shim drift.

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.
- **Before adding or modifying main views, sidebar panels, or tab infrastructure in `web-ui`**, read `docs/ui-layout-architecture.md`. It documents the dual-selection layout system, component hierarchy, auto-coupling rules, and step-by-step guides for adding new views/panels.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui conventions
- **Before any frontend work**, read `docs/web-ui-conventions.md` — it covers the stack, design tokens, UI primitives, Radix gotchas, dialog suppression rules, dark theme constraints, and the hooks architecture (domain modules vs hooks, directory structure, naming conventions).
- In `web-ui`, prefer `react-use` hooks (via `@/quarterdeck/utils/react-use`) whenever possible.
- **When modifying or creating hooks** in `web-ui/src/hooks/`: if the hook has >50 lines of non-React logic (validation, data transforms, state machine guards), extract that logic into a companion domain module (`foo-bar.ts` alongside `use-foo-bar.ts`). Domain modules are pure TS with no React imports — testable with plain `describe`/`it`. See `docs/web-ui-conventions.md` § "Hooks architecture" for the full pattern and the reference table of existing extractions.

Board state single-writer rule
- When the browser UI is connected, the UI is the **single writer** of board state via `saveProjectState` (optimistic concurrency with `expectedRevision`). Server code must **never** write board state directly — doing so bumps the server-side revision and causes the UI's next persist to hit a `ProjectStateConflictError`, surfacing a disruptive "Project changed elsewhere" toast.
- Instead of writing board state from the server, send a lightweight WebSocket message (via `RuntimeStateHub.broadcast*`) with just the data the UI needs, and let the UI apply it to its local board + persist through its normal debounced cycle. See `task_title_updated` and `task_working_directory_updated` as reference patterns.
- The board/session join point is easy to miss: authoritative project hydrate in `web-ui` must apply the server-owned runtime session projection for the `in_progress` ⇄ `review` work columns before the UI decides whether to skip the next persist. If the projection changes the hydrated board, treat it as a client-owned reconciliation that should persist through the normal UI save path; otherwise `board.json` stays stale even though the runtime truth moved the card.
- In `web-ui/src/hooks/project/project-sync.ts`, `applyAuthoritativeProjectState(...)` is the single browser-side entry point for authoritative project state. Do not re-split that pipeline in `use-project-sync.ts` or nearby code:
  - authoritative session reconciliation must use the latest local session state
  - board projection must use the reconciled session set, not raw snapshot sessions
  - same-revision cache confirmation can still require board reprojection when runtime session truth changed
  - hydration flags, cache updates, and revision/persistence re-entry should all come from that one apply result
- `project.saveState` is intentionally **board-only** on the public/browser side. Runtime session truth must come from the server-owned terminal/session store, not from browser payloads or cached board restore data. If a test or shutdown path needs to seed/persist sessions directly, use the low-level state writer (`src/state/saveProjectState`) and point it at the actual runtime state root (`$HOME/.quarterdeck` or `QUARTERDECK_STATE_HOME`), not the browser API.
- Task identity has multiple path concepts that are easy to blur:
  - project root path (`projectPath` in project-level state/providers)
  - assigned task identity path (`taskWorktreeInfo.path` / task metadata snapshot path)
  - session launch path (`RuntimeTaskSessionSummary.sessionLaunchPath`)
  `RuntimeTaskSessionSummary.sessionLaunchPath` is **not** a continuously updated live cwd stream. It is the path the current agent session was launched in. The shared schema still accepts legacy persisted `projectPath` when reading old `sessions.json`, but new code should speak `sessionLaunchPath` and use it for divergence/restart hints, not as the authoritative source for task branch/folder/shared-vs-isolated display.

Completing a feature or fix (release hygiene)
- When a todo item is done, **all three files must be updated in the same commit or PR**:
  1. `docs/todo.md` — remove the completed item (items are unnumbered; order is implicit).
  2. `CHANGELOG.md` — add a bullet under the current version section matching the existing style (feature-area headings, em-dash descriptions). If no current version section exists, create one with the next patch bump.
  3. `docs/implementation-log.md` — add a detailed entry at the top with: what changed, why, which files were touched, and the commit hash. This is the forensic record — include enough detail that someone debugging a regression can understand the full scope of the change without reading the diff.
- Skipping any of these creates drift that compounds quickly across concurrent worktrees. The changelog and implementation log are easy to forget after the code is working — do them immediately, not in a follow-up.
- When bumping the version number, always keep a `## [Unreleased]` section at the top of `CHANGELOG.md` above the new version heading. This is where subsequent changes land before the next release.

Adding a new config field
- The full checklist is in `src/config/global-config-fields.ts` (top-of-file comment). The key file for the settings dialog form is `web-ui/src/hooks/settings-form.ts` (domain module) — add to `SettingsFormValues` (type) and `resolveInitialValues` (mapping), then add the JSX control. The dirty check, reset-on-open, save payload, and web-ui save types are handled automatically (no manual wiring).

Test fixtures and merge conflicts
- Avoid touching test fixture mocks in feature branches — the config mock pattern (adding fields to 10+ test files) is the #1 conflict magnet. If you can defer test fixture updates to a final pass, or extract a shared `createDefaultMockConfig()` helper that all tests import, adding a field becomes a 1-file change instead of 12.

Session reconciliation
- Before adding dynamic UI state tied to session lifecycle (status indicators, transient panels, auto-triggered actions), check `src/terminal/session-reconciliation.ts` and ensure stale/orphaned instances of the new state have a cleanup path in the reconciliation sweep. The sweep runs every 10 seconds and currently handles dead processes, processless sessions, and stale hook metadata.
- `src/terminal/session-transition-controller.ts` is the terminal-layer owner for process-side consequences of session state-machine events and active-listener summary fanout. If input/output/restart/recovery/reconciliation code needs to apply `hook.to_review`, `hook.to_in_progress`, `process.exit`, `interrupt.recovery`, or `autorestart.denied`, route it through that controller instead of adding another private transition-side-effect path to `TerminalSessionManager`.

Misc. tribal knowledge
- Notification ownership is intentionally split:
  - `web-ui/src/runtime/runtime-state-stream-store.ts` keeps cross-project notification state bucketed by project, not as one flat task map plus a separate task→project lookup.
  - UI consumers should read the provider-owned projection (`needsInputByProject`, current-project/other-project needs-input flags) instead of re-deriving project ownership from raw notification buckets.
  - `use-audible-notifications` is the main place that may flatten project buckets back into task entries, because sound transitions are inherently cross-project and event-oriented.
- Indicator semantics are intentionally centralized:
  - Use `deriveTaskIndicatorState(summary)` and `isPermissionActivity(...)` from `src/core/api/task-indicators.ts` / `@runtime-contract` for approval, review-ready, needs-input, and failure meaning.
  - Do not add new UI logic that re-interprets `reviewReason`, `latestHookActivity.notificationType`, `hookEventName`, or `"Waiting for approval"` text directly in components/hooks. Project badges, status badges, audible notifications, and approval-blocking behavior should all flow from the shared semantic layer.
- Keep **task agent terminals** and **shell terminals** mentally separate even when they share xterm/panel plumbing.
  - Task agent terminals are task-scoped viewers for agent sessions and use the shared/pool path.
  - Shell terminals (home shell and detail shell) are dedicated workspace-scoped manual shells with different lifecycle rules, restart behavior, and exit handling.
  - If a refactor makes shell surfaces read like agent terminals again, split the abstraction instead of relying on comments or task-id prefixes alone.
- Quarterdeck is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- When Quarterdeck runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- **Terminal output ≠ agent working.** Agents (especially Claude Code) produce constant incidental terminal output — spinners, status bar updates, prompt redraws, ANSI cursor movements — even while idle or genuinely waiting for user input. Do not use `lastOutputAt` timestamps or output presence/volume as a heuristic for whether an agent has resumed working. The hook system (`to_review` / `to_in_progress`) is the authoritative source for state transitions. If a hook is missed, fix it at the hook layer.
- `docs/archive/` is gitignored and contains historical context only. Do not read or reference it unless the user explicitly asks for archival material.
- Two distinct shortcut systems exist — do not confuse them:
  - **Project shortcuts** (`RuntimeProjectShortcut`, `useShortcutActions`): Terminal commands executed in the dev shell via the top bar. Per-project config. Uses `appendNewline: true`.
  - **Prompt shortcuts** (`PromptShortcut`, `usePromptShortcuts`): Agent prompt injection via sidebar review cards. Global config. Uses paste mode + auto-submit.
