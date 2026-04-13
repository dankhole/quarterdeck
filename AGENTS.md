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
- **Before any frontend work**, read `docs/web-ui-conventions.md` — it covers the stack, design tokens, UI primitives, Radix gotchas, dialog suppression rules, and dark theme constraints.
- In `web-ui`, prefer `react-use` hooks (via `@/quarterdeck/utils/react-use`) whenever possible.

Board state single-writer rule
- When the browser UI is connected, the UI is the **single writer** of board state via `saveWorkspaceState` (optimistic concurrency with `expectedRevision`). Server code must **never** call `mutateWorkspaceState` to modify board state for operations triggered while a UI client is active — doing so bumps the server-side revision and causes the UI's next persist to hit a `WorkspaceStateConflictError`, surfacing a disruptive "Workspace changed elsewhere" toast.
- Instead of writing board state from the server, send a lightweight WebSocket message (via `RuntimeStateHub.broadcast*`) with just the data the UI needs, and let the UI apply it to its local board + persist through its normal debounced cycle. See `task_title_updated` as the reference pattern.
- `mutateWorkspaceState` is only safe for CLI-only code paths where no browser UI is connected (e.g. `quarterdeck hooks ingest`, `quarterdeck task` subcommands).

Completing a feature or fix (release hygiene)
- When a todo item is done, **all three files must be updated in the same commit or PR**:
  1. `docs/todo.md` — remove the completed item and renumber remaining items. Update any cross-references (e.g. `#12` → `#11`).
  2. `CHANGELOG.md` — add a bullet under the current version section matching the existing style (feature-area headings, em-dash descriptions). If no current version section exists, create one with the next patch bump.
  3. `docs/implementation-log.md` — add a detailed entry at the top with: what changed, why, which files were touched, and the commit hash. This is the forensic record — include enough detail that someone debugging a regression can understand the full scope of the change without reading the diff.
- Skipping any of these creates drift that compounds quickly across concurrent worktrees. The changelog and implementation log are easy to forget after the code is working — do them immediately, not in a follow-up.
- When bumping the version number, always keep a `## [Unreleased]` section at the top of `CHANGELOG.md` above the new version heading. This is where subsequent changes land before the next release.

Adding a new config field
- The full checklist is in `src/config/global-config-fields.ts` (top-of-file comment). The key file for the settings dialog form is `web-ui/src/hooks/use-settings-form.ts` — add to `SettingsFormValues` (type) and `resolveInitialValues` (mapping), then add the JSX control. The dirty check, reset-on-open, save payload, and web-ui save types are handled automatically (no manual wiring).

Test fixtures and merge conflicts
- Avoid touching test fixture mocks in feature branches — the config mock pattern (adding fields to 10+ test files) is the #1 conflict magnet. If you can defer test fixture updates to a final pass, or extract a shared `createDefaultMockConfig()` helper that all tests import, adding a field becomes a 1-file change instead of 12.

Session reconciliation
- Before adding dynamic UI state tied to session lifecycle (status indicators, transient panels, auto-triggered actions), check `src/terminal/session-reconciliation.ts` and ensure stale/orphaned instances of the new state have a cleanup path in the reconciliation sweep. The sweep runs every 10 seconds and currently handles dead processes, processless sessions, and stale hook metadata.

Misc. tribal knowledge
- Quarterdeck is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- When Quarterdeck runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- **Terminal output ≠ agent working.** Agents (especially Claude Code) produce constant incidental terminal output — spinners, status bar updates, prompt redraws, ANSI cursor movements — even while idle or genuinely waiting for user input. Do not use `lastOutputAt` timestamps or output presence/volume as a heuristic for whether an agent has resumed working. The hook system (`to_review` / `to_in_progress`) is the authoritative source for state transitions. If a hook is missed, fix it at the hook layer.
- Two distinct shortcut systems exist — do not confuse them:
  - **Project shortcuts** (`RuntimeProjectShortcut`, `useShortcutActions`): Terminal commands executed in the dev shell via the top bar. Per-project config. Uses `appendNewline: true`.
  - **Prompt shortcuts** (`PromptShortcut`, `usePromptShortcuts`): Agent prompt injection via sidebar review cards. Global config. Uses paste mode + auto-submit.
