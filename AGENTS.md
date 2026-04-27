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

Documentation lookup cheat sheet
- Read the area-specific docs when you enter that area; do not bulk-read every convention doc by default.
- `docs/conventions/web-ui.md`: read before frontend work in `web-ui` for stack, design tokens, UI primitives, Radix gotchas, dialog suppression, dark theme, and hook directory rules.
- `docs/conventions/frontend-hooks.md`: read when extracting hook/domain logic, changing provider/context contracts, or applying the frontend domain-module pattern.
- `docs/conventions/ui-layout.md`: read before adding or modifying main views, sidebar panels, toolbar tabs, task-detail layout routing, or surface-navigation behavior.
- `docs/conventions/architecture-guardrails.md`: read when adding caching, batching, retry, preload, recovery, lifecycle policy, or any clever behavior that could start defining the architecture.
- `docs/architecture-roadmap.md`: read when choosing, reprioritizing, or touching active architecture refactor backlog items.
- `docs/task-state-system-stale.md`: historical task/session state context only; verify against current code before relying on it.

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
- In `web-ui`, prefer `react-use` hooks (via `@/quarterdeck/utils/react-use`) whenever possible.
- **When modifying or creating hooks** in `web-ui/src/hooks/`: if the hook has >50 lines of non-React logic (validation, data transforms, state machine guards), extract that logic into a companion domain module (`foo-bar.ts` alongside `use-foo-bar.ts`). Domain modules are pure TS with no React imports — testable with plain `describe`/`it`. See `docs/conventions/web-ui.md` § "Hooks architecture" for the full pattern, and `docs/conventions/frontend-hooks.md` for the deeper methodology.

Board state single-writer rule
- When the browser UI is connected, the UI is the **single writer** of board state via `saveProjectState` (optimistic concurrency with `expectedRevision`). Server code must **never** write board state directly — doing so bumps the server-side revision and causes the UI's next persist to hit a `ProjectStateConflictError`, surfacing a disruptive "Project changed elsewhere" toast.
- Instead of writing board state from the server, send a lightweight WebSocket message (via `RuntimeStateHub.broadcast*`) with just the data the UI needs, and let the UI apply it to its local board + persist through its normal debounced cycle. `task_title_updated` is the main reference pattern for task-scoped lightweight sync.
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
- Restore-from-trash must wait for the previous task session to finish exiting before it asks the runtime to resume the conversation. The trash flow already calls `stopTaskSession(..., { waitForExit: true })`, but users can untrash before that stop settles; if restore calls `startTaskSession` too early, `TerminalSessionManager.startTaskSession()` can short-circuit on the still-active old entry and leave the restored card with no live process once the old session finally exits.
- `waitForExit` is not just a courtesy delay; if the old PTY is still exiting when a new start/resume arrives for the same task, treat that as an explicit failure and log it. Do **not** silently reuse the old `running`/`awaiting_review` summary while `suppressAutoRestartOnExit` is set, or untrash/restart can leave the UI on a loading spinner with no live agent or useful warning. Resume paths that go through `codex resume --last` (missing `resumeSessionId`) or Claude `--continue` (relies on cwd match) are also silent-failure prone — the adapter emits a warning when it falls back to `--last`, and the tRPC handler warns if `resumeConversation=true` arrives without a stored `resumeSessionId`.
- The resume-failure fallback in task session exit handling must not run after an explicit stop (`suppressAutoRestartOnExit` / auto-restart reason `suppressed`). If a user trashes a resumed Codex task, the stopped resume process can otherwise schedule a fresh non-resume start, which clears the stored `resumeSessionId` before the real untrash resume arrives and forces a `codex resume --last` fallback. Do not block that fallback solely because the resume process exited 0: startup resume can rely on the fallback after a `codex resume`/`--continue` process exits cleanly without leaving an interactive session.
- Startup resume selector failures should not be debug-only. If `resumeInterruptedSessions(...)` cannot load state, resolve an agent, find interrupted work-column sessions, or launch a selected task, emit a `warn` with enough scan context to distinguish "no interrupted task was selected" from "selected task failed to start." Routine per-card breadcrumbs can stay `info`/`debug`, but a server-start resume miss should be visible at the default log level.
- Task PTY exit callbacks must be tied to the specific spawned `PtySession`, not just the task id. A delayed exit from an old Codex wrapper/PTY can arrive after a replacement resume session has already spawned for the same task; if the exit handler finalizes by task id alone, it can clear the new active entry and leave the restored task on an empty terminal/spinner.
- Session-driven terminal refreshes can race the first control-socket restore. If the UI notices a new task session instance (`startedAt` / `pid`) before the initial restore finishes, do not drop the follow-up `request_restore`; queue it in `web-ui/src/terminal/slot-socket-manager.ts` and replay it from `markRestoreCompleted()`, or restored tasks can stay stuck on the empty pre-spawn snapshot with a spinner and no logs.
- A task terminal must not keep the loading overlay up forever just because the control-socket restore handshake stalls. Once the IO socket is open, the terminal is usable for input; `web-ui/src/terminal/terminal-session-handle.ts` has a readiness fallback that reveals the terminal and clears loading instead of leaving the user blocked behind a spinner. Make sure that fallback is armed for reused pooled slots and delayed IO-open events, not just brand-new task connections. Do not pair this fallback with a speculative `request_restore`: if live Codex output has already reached xterm, a stale or empty restore snapshot can reset the visible buffer back to blank. When a live task session instance changes (`startedAt` / non-null `pid`), drop and reopen the pooled terminal sockets instead of queueing `request_restore` on an existing control socket; dogfood showed reused ACTIVE slots can keep a control socket stuck in `restoreCompleted=false` forever. Do not reconnect on processless stop summaries (`pid: null`) or trash/untrash flashes an old terminal before the real replacement process starts. When guarding against empty restore snapshots in `TerminalViewport`, drain queued writes before reading the visible buffer; otherwise live output that is queued but not yet flushed can still be erased.
- Startup resume and trash restore do **not** preserve the same task identity for isolated Claude sessions. Server-start resume uses the persisted `card.workingDirectory` from the still-existing worktree, but trash explicitly clears `workingDirectory` and deletes the worktree before untrash recreates it. Claude resume is only `--continue` (cwd-scoped, no stored session id), so untrash can reopen a fresh Claude prompt instead of the old chat even when startup resume works. If code is resuming Claude after trash with no persisted worktree path, emit an explicit warning/log rather than treating it like the startup-resume path.

Misc. tribal knowledge
- Notification ownership is intentionally split:
  - `web-ui/src/runtime/runtime-state-stream-store.ts` keeps cross-project notification state bucketed by project, not as one flat task map plus a separate task→project lookup.
  - UI consumers should read the provider-owned projection (`needsInputByProject`, current-project/other-project needs-input flags) instead of re-deriving project ownership from raw notification buckets.
  - `use-audible-notifications` is the main place that may flatten project buckets back into task entries, because sound transitions are inherently cross-project and event-oriented.
- Indicator semantics are intentionally centralized:
  - Use `deriveTaskIndicatorState(summary)` and `isPermissionActivity(...)` from `src/core/api/task-indicators.ts` / `@runtime-contract` for approval, review-ready, needs-input, and failure meaning.
  - Do not add new UI logic that re-interprets `reviewReason`, `latestHookActivity.notificationType`, `hookEventName`, or `"Waiting for approval"` text directly in components/hooks. Project badges, status badges, audible notifications, and approval-blocking behavior should all flow from the shared semantic layer.
- Codex `session_meta` is a metadata-only signal:
  - Persist `resumeSessionId` from Codex `session_meta`, but do **not** let that event clobber `latestHookActivity` or bump summary state twice. If resume-id persistence and hook activity need to land together, use one store mutation (`applyHookMetadata(...)`) rather than separate `update(...)` + `applyHookActivity(...)` calls.
  - The rollout fallback and live session-log parser have separate dedupe paths. Even if the incoming session id is already stored, a metadata-only `session_meta` event must remain a no-op for activity/broadcast purposes or it will wipe real Codex activity and emit redundant websocket updates.
- Keep **task agent terminals** and **shell terminals** mentally separate even when they share xterm/panel plumbing.
  - Task agent terminals are task-scoped viewers for agent sessions and use the shared/pool path.
  - Shell terminals (home shell and detail shell) are dedicated workspace-scoped manual shells with different lifecycle rules, restart behavior, and exit handling.
  - If a refactor makes shell surfaces read like agent terminals again, split the abstraction instead of relying on comments or task-id prefixes alone.
- Quarterdeck is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- Native Codex hooks need to stay launch-scoped. Do not write Quarterdeck-managed hooks into repo-local `.codex/hooks.json` or user-global `~/.codex/hooks.json`, because Codex app/GUI sessions will load them too and start failing outside Quarterdeck. Pass Quarterdeck's Codex hook config inline on the `codex` command line (`-c hooks...` plus `--enable codex_hooks`) so only Quarterdeck-launched Codex sessions get the task-state hooks. Preserve the invariant that only genuine "waiting for user input / approval" situations should surface as needs-input.
- Codex `SessionStart` must stay metadata-only in Quarterdeck. Codex can emit it for launch/resume and around session-maintenance flows such as compaction; mapping it to `to_in_progress` makes review-ready cards jump to running with no later `Stop`. Slash commands such as `/compact`, `/resume`, and plugin reloads do not expose stable native start/finish hooks yet, so do not infer state from prompt redraws or TUI output.
- When Quarterdeck runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- **Terminal output ≠ agent working.** Agents (especially Claude Code) produce constant incidental terminal output — spinners, status bar updates, prompt redraws, ANSI cursor movements — even while idle or genuinely waiting for user input. Do not use `lastOutputAt` timestamps or output presence/volume as a heuristic for whether an agent has resumed working. The hook system (`to_review` / `to_in_progress`) is the authoritative source for state transitions. If a hook is missed, fix it at the hook layer.
- `docs/archive/` is gitignored and contains historical context only. Do not read or reference it unless the user explicitly asks for archival material.
- Two distinct shortcut systems exist — do not confuse them:
  - **Project shortcuts** (`RuntimeProjectShortcut`, `useShortcutActions`): Terminal commands executed in the dev shell via the top bar. Per-project config. Uses `appendNewline: true`.
  - **Prompt shortcuts** (`PromptShortcut`, `usePromptShortcuts`): Agent prompt injection via sidebar review cards. Global config. Uses paste mode + auto-submit.
