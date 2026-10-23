# opencode first-class support — paused work handoff

Status: **paused, work in progress** (branch `feat/opencode-support`). This build does not typecheck yet and opencode launches are not usable end to end. Delete this file, or move it to `docs/history/`, once the work lands.

## Where each workstream stopped

| Workstream | State | Remaining |
|---|---|---|
| E — docs | Done | Re-check against the final behavior; docs describe the planned contract, including runtime pieces A has not built yet. |
| C — catalog (`opencode models` / `opencode agent list`, `runtime.opencodeCatalog` tRPC) | Done; focused tests passed (`test/runtime/execution/opencode-catalog*.test.ts`, `test/runtime/trpc/runtime-api.test.ts`) | Drop the temporary `"opencode" as unknown as RuntimeAgentId` cast in `src/config/opencode-catalog.ts`. Consider sharing the probe-spawn helper with `agent-registry.ts` rather than the local reimplementation. |
| A — core contracts / runtime spine | **Partial** (stopped mid-edit in `src/terminal/session-manager.ts`) | Done: agent enums incl. `opencode`, `src/core/agent-capabilities.ts`, `opencodeOptions` schema/plumbing (core, board commands, start service, session lifecycle types), exact-pin registry (`SUPPORTED_OPENCODE_VERSION = "1.19.4"`, shared exact-pin helper), catalog entry (**missing required `description`** → typecheck error), auto-select priority, orphan cleanup, resume-failure warnings, protocol version 7→8, predicates used in task-indicators/quick-reply/task-session/start service. **Not done:** the runtime hook semantics — `session-state-machine.ts`, `hook-event-order.ts` (run-scoped evaluator still Pi-only), `session-transition-controller.ts`, `trpc/hooks-api.ts` (provider ownership checks at :81 and :247 still exclude opencode, so opencode hooks are ignored), `hook-transition-outbox-core.ts` replay identity, `startup-session-recovery.ts`, `session-auto-restart.ts`, `session-input-pipeline.ts`, finishing the session-manager warning lookup, `opencode_support` diagnostics provider (doctor/runtime-server), subagent (`providerAgentId`) routing + `SubagentStop` retirement, `QuestionAsked` interaction kind, and all A tests. `git grep -n '=== "pi"' -- src` lists the remaining inline checks. |
| B — plugin + launch adapter | **Partial** (stopped while wiring the adapter) | `src/terminal/opencode-lifecycle-plugin.runtime.js` (≈600 lines) and `opencode-lifecycle-plugin.ts` exist; `opencodeAdapter` is registered in `agent-session-adapters.ts`; build/global-setup asset copy updated. **Unverified:** no plugin or adapter tests yet (`test/runtime/terminal/opencode-lifecycle-plugin.test.ts` was never written); review the plugin against the vocabulary table below and the adapter's resume/model/agent/prompt/env handling. |
| D — web UI | **Partial** (stopped while writing drafts tests) | Agent selector/display/settings/onboarding, `task-opencode-options.tsx` (+ test), and `opencodeOptions` plumbing are in. Fix web-ui typecheck errors in `task-create-dialog.test.tsx:154` and `use-task-editor.test.tsx:108` (test fixtures typed to the old 3-agent union); finish the remaining tests; run focused web-ui vitest. |
| R — plan review | **Did not run** (API budget cap hit) | Run it before finishing A/B. Its brief covered lifecycle contracts, opencode event-order facts (repeated `session.status` busy, plugin load timing vs first prompt, internal sessions without `parentID`, `--prompt` on resume, Bun worker `process.env`/`child_process`), missing enumeration sites, Windows/packaging, diagnostics privacy, and catalog cost. |
| Final parallel review + fixes | Not started | — |

Typecheck state at pause: root `npm run typecheck` → 2 errors (`src/core/agent-catalog.ts:59` missing `description`; `scripts/agent-lab/fixture.ts:463` agent union). web-ui `tsc` → 3 errors (the catalog one plus the two test fixtures above).

## Resuming

1. Fix the typecheck errors above.
2. Run the plan review (R) against the current code, then finish A's runtime semantics and B's tests, with focused tests per `docs/testing.md`.
3. Run the final review pass, and update the docs (E) if behavior moved away from this plan.
4. Do not validate against a real opencode without explicit authorization (it is not installed on the original dev machine). opencode 1.19.4 source was read from tag `v1.19.4` of `anomalyco/opencode` (commit `148842ef7cb1bc34192b3fff57d0f9721ab9c801`). Re-clone it to re-check facts; the `/tmp` research copies do not persist.

### Research risks still open (static source reading only, not observed in a live run)

- `question.*` events reach the plugin `event` hook but are absent from the typed `@opencode-ai/sdk@1.19.4` `Event` union — match `event.type` as a string.
- Alternate-screen use is inferred from the `@opentui/core` renderer, not confirmed.
- Whether a top-level `--agent <subagent-only name>` is rejected was not confirmed; the catalog filters subagent-only agents.
- Background subagents require `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` and may change without notice; the default `task` tool blocks the parent turn.
- `opencode models` may be empty offline on a fresh machine (models.dev cache).

---

## Original plan: first-class opencode task agent (Pi-parity) + model/agent picker + subagent tracking

Worktree: `/Users/d.cole/.quarterdeck/worktrees/9144e/quarterdeck` (detached HEAD; shared by all workers; dependencies installed). Do not commit, push, stash, check out, or run `npm run dev*`/`dogfood`/`quarterdeck`. Do not run a real opencode or any real provider. opencode is not installed locally.

Verified opencode facts (static source, tag v1.19.4, `anomalyco/opencode`; raw sources under `/tmp/opencode-research/` — read-only, never execute): see "opencode facts" at the bottom. Read `AGENTS.md`, plus the routed doc for your area (`docs/conventions/session-lifecycle.md` for runtime/terminal, `docs/conventions/runtime-state.md` for board/schemas, `docs/conventions/web-ui.md` + `docs/conventions/frontend-hooks.md` for web-ui, `DEVELOPMENT.md#browserruntime-compatibility` for API contracts).

## Goals / acceptance

1. `opencode` is a launch-supported `RuntimeAgentId` pinned to exactly `1.19.4` (same exact-pin policy as Pi), detected on PATH, shown in Settings, onboarding, and the task agent selector; auto-select priority after Pi.
2. Every Quarterdeck-managed opencode launch loads a launch-scoped lifecycle plugin that drives Running / Review / Needs Input / Interrupted / Error through the existing durable hook pipeline with launch-scoped identity (same guarantees as Pi: `hooks ingest` for state transitions with a serialized durable queue and frozen run/session identity; `hooks notify` for best-effort activity).
3. Exact resume uses `--session <storedId>`; best-effort resume uses `--continue`; a failed targeted resume becomes Review/Error and never replays the prompt (reuse the existing resume-failure machinery).
4. Per-task model + agent selection (`opencodeOptions: { model?, agent? }`) persisted on the card and passed as `--model` / `--agent`, with choices from a runtime-owned catalog (`opencode models`, `opencode agent list`) and free-text model fallback.
5. Subagent support: child sessions (task tool, `parentID`) never end or start the root turn; their permission/question waits are surfaced as subagent-scoped interactions (`providerAgentId` = child session id, mirroring Claude subagent handling); experimental background subagents keep the task In Progress until they finish (with safeguards).
6. Inline `agentId === "codex" || "claude" || "pi"` checks are replaced by shared predicates so a fourth agent is a single-point change.
7. Protocol: adding `"opencode"` to the agent enums breaks older browsers parsing boards → bump `QUARTERDECK_RUNTIME_PROTOCOL_VERSION` 7 → 8 (src/core/api/runtime-protocol.ts) with whatever regression test the policy already has.
8. Focused tests for each workstream; lanes' typechecks pass (`npm run typecheck` root and web-ui equivalents — check package.json scripts). Do NOT run full test suites; run focused vitest files.

## Shared contracts (all workers code against these exactly)

### Agent id / capability predicates — new file `src/core/agent-capabilities.ts` (owner: A), exported from `src/core/index.ts`

```ts
export const NATIVE_LIFECYCLE_AGENT_IDS = ["claude", "codex", "pi", "opencode"] as const satisfies readonly RuntimeAgentId[];
export function isNativeLifecycleAgentId(id: string | null | undefined): id is RuntimeAgentId; // claude|codex|pi|opencode
/** Providers whose launch-scoped extension/plugin reports run-scoped AgentStart/AgentSettled lifecycles (Pi model). */
export function isRunScopedExtensionProvider(source: string | null | undefined): source is "pi" | "opencode";
```
Enums (`runtimeAgentIdSchema`, `runtimeMaintainedAgentIdSchema`, `runtimeTaskInteractionProviderSchema`, hook `source` enum) gain `"opencode"`.

### Per-task options (owner: A, in `src/core/api/board.ts`)

```ts
const runtimeOpencodeAgentNameSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const runtimeOpencodeOptionsSchema = z.object({
  model: runtimeAgentModelIdSchema.optional(),   // "provider/model"
  agent: runtimeOpencodeAgentNameSchema.optional(),
});
export type RuntimeOpencodeOptions = z.infer<typeof runtimeOpencodeOptionsSchema>;
```
Card field `opencodeOptions?: RuntimeOpencodeOptions`, plumbed exactly like `codexOptions` through: board card schema, `project-board-command.ts` (api + core equality), `task-lifecycle.ts`, `task-board-mutations.ts` (only kept when `agentId === "opencode"`), `task-session-start-service.ts`, `terminal/session-lifecycle.ts`, `terminal/session-manager-types.ts` (`opencodeOptions?: AgentAdapterLaunchInput["opencodeOptions"]`), adapter input `AgentAdapterLaunchInput.opencodeOptions?: RuntimeOpencodeOptions` (owner B adds the field in agent-session-adapters.ts).

### Catalog API (owner: C)

`src/core/opencode-catalog-contracts.ts`:
```ts
export const runtimeOpencodeModelSchema = z.object({ id: z.string().min(1) /* "provider/model" */, providerId: z.string().min(1), modelId: z.string().min(1) });
export const runtimeOpencodeAgentSchema = z.object({ name: z.string().min(1), mode: z.enum(["primary", "all"]) }); // subagent-only filtered out
export const runtimeOpencodeCatalogResponseSchema = z.object({ models: z.array(runtimeOpencodeModelSchema), agents: z.array(runtimeOpencodeAgentSchema) });
```
tRPC: `runtime.opencodeCatalog` (optionalProjectProcedure, output schema above), mirroring `runtime.codexModels` (src/trpc/app-router.ts, app-router-context.ts, runtime-api.ts). Web UI consumes `getRuntimeTrpcClient(projectId).runtime.opencodeCatalog.query()`.

### Hook vocabulary emitted by the opencode plugin (owner B emits; owner A makes runtime accept)

All with `--source opencode`, `--session-id <rootSessionId>`, `--turn-id <runId>` (run id = random UUID per root busy period, frozen at enqueue time like Pi). Durable (`hooks ingest`, serialized queue) unless marked notify.

| hookEventName | event | when |
|---|---|---|
| `session_meta` | activity (durable) | first time a root session id is observed, and whenever the observed root id changes |
| `AgentStart` | to_in_progress | root `session.status` → busy while no active run |
| `ToolExecutionStart` / `ToolExecutionEnd` / `ToolExecutionFailure` | activity (notify) | root `tool.execute.before/after` (`toolUseId` = callID; failure when output metadata/error indicates) |
| `PermissionRequest` | to_review | `permission.updated` (or `permission.ask` hook) for root or child; `toolName` = permission.type, `toolUseId` = callID, `notificationType` = `permission_prompt`; child sessions add `--provider-agent-id <childSessionId>` |
| `PermissionReplied` | to_in_progress | `permission.replied` with response other than reject (same provider-agent id rule); reject → activity `PermissionRejected` (notify) |
| `QuestionAsked` | to_review | runtime event `question.asked` (not in typed SDK union — treat `event.type` as string) → interaction kind `question` |
| `QuestionReplied` | to_in_progress | `question.replied`; `question.rejected` → activity `QuestionRejected` |
| `Retry` | activity (notify) | root `session.status` retry |
| `SubagentStart` / `SubagentStop` | activity (durable for SubagentStop) | child session busy / idle-or-error; `--provider-agent-id <childSessionId>`; SubagentStop retires any outstanding child interaction (mirror Claude `SubagentStop`) |
| `BackgroundWait` | activity (notify) | root idle while ≥1 background child still busy (see subagents) |
| `AgentSettled` / `Interrupt` / `StopFailure` | to_review | root `session.idle` ending the run: `Interrupt` if the run saw root `session.error` with `MessageAbortedError`; `StopFailure` for other root `session.error`; else `AgentSettled` with `finalMessage` = last root assistant text |

## Workstreams (disjoint file ownership; ask the lead before touching another owner's file)

### A — Core contracts & runtime spine (sonnet, xhigh)
Owns: `src/core/**` (except `src/core/opencode-catalog-contracts.ts`), `src/config/agent-registry.ts`, `src/config/runtime-config*.ts`, `src/server/**`, `src/terminal/**` EXCEPT `agent-session-adapters.ts` and `opencode-lifecycle-plugin*`, `src/trpc/hooks-api.ts`, `src/hook-*.ts`, `src/hooks-runtime-client.ts`, `src/commands/**`, `src/diagnostics/**`, `src/state/**`, plus their tests under `test/` (excluding B/C test files).
- Catalog entry (label "opencode", binary `opencode`, install `npm install -g opencode-ai@1.19.4` — needs postinstall, so no `--ignore-scripts`; installUrl npm page for 1.19.4; signIn `opencode auth login`, description "Run opencode auth login and choose a provider."). `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS` + `AUTO_SELECT_AGENT_PRIORITY` append opencode.
- `SUPPORTED_OPENCODE_VERSION = "1.19.4"`; generalize `resolvePiAvailability` into an exact-pin helper used by both (messages name the right npm package). `opencode --version` prints bare `1.19.4`.
- Agent predicates file; replace every inline `codex||claude||pi` check across src (grep `=== "pi"` and `"codex" || ` patterns) with `isNativeLifecycleAgentId` / `isRunScopedExtensionProvider` as semantically appropriate. Pi-specific branches that are about the run-scoped extension model (hook-event-order Pi evaluator + retirement, `agentsettled` handling in session-transition-controller / hooks-api, Interrupt reducer branch in session-state-machine `(provider === "pi" && summary.agentId !== "pi")` → provider must equal summary.agentId, outbox replay identity) become run-scoped-provider generic. Keep genuinely Pi-only things Pi-only (`input` identity_only, `projecttrustrequest`). Renaming `activePiRunId`-style fields to neutral names is allowed if you update their tests.
- State machine: `getInteractionKind` — opencode `questionasked` → `question`; `permissionrequest` already generic. Ensure `to_in_progress` `PermissionReplied`/`QuestionReplied` resume Running from a matching outstanding interaction, and that child-scoped (`providerAgentId`) interactions route through the existing subagent reducer (`getSubagentId`/`reduceSubagentHook`) the same way Claude's do — inspect how Claude subagent ids are recognized (it may be Claude-only) and extend to opencode. `SubagentStop` for opencode must retire that child's interaction. Child events must never establish or end root Running.
- Resume warnings: add `STORED_OPENCODE_RESUME_FAILED_WARNING` (resume-failure.ts) and an opencode best-effort warning in task-session-start-service (mirrors Pi text); session-manager warning selection must map opencode (make it a lookup, not a ternary chain).
- orphan-cleanup process names + `opencode`; doctor/runtime-server: add `opencode_support` diagnostic provider mirroring `pi_support` (fingerprint from B's `getOpencodeLifecyclePluginFingerprint()` exported from `src/terminal/opencode-lifecycle-plugin.ts`).
- `opencodeOptions` plumbing per contract (server + terminal side + core board command equality).
- Protocol version bump 7→8.
- Tests: extend existing Pi-focused unit tests (hook-event-order, session-state-machine, transition controller, hooks-api, agent-registry, task-board-mutations, project-board-command) with opencode cases: run start → tools → settle; interrupt; failure; stale run rejection; child permission → subagent wait → SubagentStop retires; child idle doesn't settle root; PermissionReplied resumes Running; question interaction.

### B — opencode lifecycle plugin + launch adapter (sonnet, xhigh)
Owns: `src/terminal/opencode-lifecycle-plugin.runtime.js` (new, plain ESM JS like the Pi asset), `src/terminal/opencode-lifecycle-plugin.ts` (new: `QUARTERDECK_OPENCODE_HOOK_COMMAND_ENV = "QUARTERDECK_OPENCODE_HOOK_COMMAND_JSON"`, `buildOpencodeLifecyclePluginSource()`, `getOpencodeLifecyclePluginFingerprint()`, same placeholder/asset-resolution pattern as `pi-lifecycle-extension.ts`), `src/terminal/agent-session-adapters.ts`, `scripts/build.mjs` (copy asset), `test/global-setup.ts` + `test/utilities/global-setup.test.ts` (asset copy), new `test/runtime/terminal/opencode-lifecycle-plugin.test.ts`, adapter tests.
- Plugin module: `export default { id: "quarterdeck-lifecycle", server: async (input) => hooks }` (id is required for file plugins). Runs inside opencode's Bun worker thread; use only `node:child_process`/`node:crypto` like the Pi asset; read hook command parts from `process.env[QUARTERDECK_OPENCODE_HOOK_COMMAND_JSON]`; must never throw out of a hook (wrap everything); never block tool calls or change permissions (`permission.ask` hook, if used, must leave `output.status` untouched).
- Root/child classification: a session is a child iff a `session.created`/`session.updated` event carried `info.parentID` (children are always created during the plugin's lifetime); otherwise root. The first observed root id is the launch's root; a different root id (user `/new` or session switch in the TUI) → emit `session_meta` with the new id and reset run state (runtime handles identity change like Codex conversation switches — A verifies).
- Run tracking per the vocabulary table; durable queue + frozen identity copied from Pi; dedupe: `session.status` busy repeats during an active run do not start a new run; `retry` keeps run; `session.idle` without an active run is ignored (except it may end BackgroundWait).
- Final message: track root assistant messages from `message.updated` (role assistant) + `message.part.updated` text parts; truncate like Pi.
- Background subagents (only possible with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`): maintain busy child set. On root idle with busy children → emit `BackgroundWait` instead of settle; when last child goes idle/error and root is idle and no new root busy within 1.5 s grace → emit `AgentSettled` (same run id). Safeguard: 60-minute cap → settle; on process `beforeExit`/dispose hook clear timers. Interrupt/failure at root still settle immediately (Interrupt/StopFailure) regardless of children.
- Adapter `opencodeAdapter`:
  - Resume with id: strip `--session`/`-s` (with value), `--continue`/`-c`, `--fork`; push `--session <id>`. Resume without id: add `--continue` unless user args already have `--continue/-c/--session/-s`.
  - `opencodeOptions.model` → replace any `--model`/`-m` in args with `--model <model>`; `.agent` → replace `--agent` with `--agent <name>`.
  - Prompt via `withPrompt(args, prompt, "flag", "--prompt")` (positional is the project dir, never pass prompt positionally).
  - Hooks: write plugin to `<state-home>/hooks/opencode/quarterdeck-lifecycle.js` (`getHookAgentDirectory("opencode")`), env: `createHookRuntimeEnv(...)`, `QUARTERDECK_OPENCODE_HOOK_COMMAND_JSON` (notify command parts), `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_CONFIG_CONTENT` = merge of inherited `OPENCODE_CONFIG_CONTENT` (from input.env ?? process.env; if present and a JSON object, append our `pathToFileURL(pluginPath).href` to its `plugin` array; if present but unparseable/non-object, fail the launch with a clear error rather than silently dropping user config) — otherwise `{"plugin":["file:///…"]}`. Remove an inherited `OPENCODE_PURE` (it disables all plugins) by setting it `undefined` in the launch env (verify `mergeProcessEnvironment` semantics) and log it.
  - Never add `--auto`/`--yolo`/`--dangerously-skip-permissions`.
- Plugin tests: import the runtime asset in Node with a fake `input` and fake hook command (pattern: `test/runtime/terminal/pi-lifecycle-extension.test.ts`), driving events and asserting emitted CLI args/order: normal run, interrupt (`MessageAbortedError` then idle), failure, retry, tools, permission root/child + reply/reject, question, child busy/idle doesn't settle root, background wait + grace + cap (fake timers), session switch emits new session_meta, hooks never throw on malformed events.

### C — opencode catalog discovery (sonnet, high)
Owns: `src/core/opencode-catalog-contracts.ts`, `src/config/opencode-catalog.ts`, `src/config/opencode-catalog-cache.ts`, `src/trpc/app-router.ts`, `src/trpc/app-router-context.ts`, `src/trpc/runtime-api.ts`, and their tests.
- Loader resolves the command via `resolveAgentCommandForLaunch({...config, selectedAgentId: "opencode"})` (metadata-only; never starts a session), runs `opencode models` and `opencode agent list` concurrently with `cwd` = project path, env `{...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1"}`, 10 s timeout each, bounded stdout (e.g. 4 MiB), through the same process-launch admission/timeout helpers the registry uses (`armChildProcessTimeout`, `assertRuntimeProcessLaunchAdmission`, `resolveWindowsCompatibleCommand`). Parse models: lines matching `^([^/\s]+)\/(\S+)$` (skip `--verbose` JSON); agents: lines matching `^(\S+) \((primary|subagent|all)\)$`, drop `subagent`. Cap list sizes (e.g. 5000 models). Strip ANSI.
- Cache class mirroring `CodexModelCatalogCache` (per-cwd, 5 min fresh, stale-while-revalidate, failure backoff). One partial failure (models fail, agents ok) → return what succeeded? Decide: return both arrays, empty on the failing side, but if both fail throw.
- tRPC route + runtime-api method per contract.

### D — Web UI (sonnet, xhigh)
Owns everything under `web-ui/` (implementation + tests).
- Agent display/order (`web-ui/src/utils/task-agent-display.ts`: label "opencode"), `task-agent-selector.tsx`, settings `agent-section.tsx`, onboarding carousel, `test-utils/runtime-config-factory.ts`.
- New `web-ui/src/components/task/task-opencode-options.tsx` modelled on `task-codex-options.tsx` + `task-option-selector.tsx`: agent select (from catalog, "Default" = unset) and model select (searchable if the existing selector supports it; otherwise grouped by provider; allow "Default" and free-text entry validated against the model regex). Loading/error states never block task creation.
- Plumb `opencodeOptions` through `types/board.ts`, `state/board-state-parser.ts`, `state/board-state.ts`, `hooks/board/task-editor-drafts.ts`, `use-task-editor.ts`, `use-task-start-actions.ts`, `project/project-board-command-sync.ts`, `components/app/app-dialogs.tsx`, `task-create-dialog.tsx` — exactly mirroring codexOptions (drop when agent ≠ opencode).
- Any other web-ui place enumerating agents (grep web-ui/src for `"pi"` and `agentId ===`).
- Tests: options component, selector lists opencode, drafts/sync keep opencodeOptions only for opencode, parser accepts it.

### E — Docs (sonnet, medium)
Owns: `docs/**` (not history), `README.md`, `AGENTS.md` (supported-agents paragraph only: add opencode pinned in `src/config/agent-registry.ts`, same compatibility rule as Pi) — then run `npm run check:agent-instructions`.
- `docs/conventions/session-lifecycle.md`: new "opencode lifecycle plugin" subsection next to "Pi lifecycle extension": injection via `OPENCODE_CONFIG_CONTENT` (additive, preserves user plugins; unparseable inherited value fails launch), `OPENCODE_PURE` removal, `OPENCODE_DISABLE_AUTOUPDATE`, root/child classification, hook vocabulary, subagent waits, background-subagent hold with 1.5 s grace / 60 min cap, exact resume (`--session` hard-fails unknown ids), no trust prompt, never auto-approves. Update places that enumerate "Codex, Claude, and Pi" where the rule now also covers opencode.
- README agent list; catalog/picker mention in the owning guide if one documents task options (grep docs for "Codex model" / "codexOptions").

### R — Plan review (opus, high, read-only)
Reads this plan + code; returns gotchas, misses, races, contract errors. Lead relays fixes to workers.

## opencode facts (v1.19.4, static-source verified)
- `opencode --version` → bare `1.19.4`. npm `opencode-ai` installs platform binary via postinstall.
- Plugin injection: `OPENCODE_CONFIG_CONTENT` JSON merged last among local sources; `plugin` arrays concatenated and deduped by identity (file URL). `file://` absolute path OK. Module default export `{ id, server: Plugin }`; `Plugin = (input: {client, project, directory, worktree, serverUrl, $, experimental_workspace}, options?) => Promise<Hooks>`. `OPENCODE_PURE` disables all plugins. Plugins run in a Bun Worker thread inside the single opencode process.
- Hooks: `event({event})` receives every bus event unfiltered; `tool.execute.before({tool, sessionID, callID}, {args})`, `tool.execute.after({tool, sessionID, callID, args}, {title, output, metadata})`, `permission.ask(Permission, {status})`, `chat.message`, etc.
- Events: `session.status{sessionID,status:{type:"busy"|"idle"|"retry",...}}`, `session.idle{sessionID}` (after every idle transition, incl. abort/error), `session.error{sessionID?, error?: {name: "MessageAbortedError"|"ProviderAuthError"|"UnknownError"|"MessageOutputLengthError"|"APIError", data}}` (published before the idle), `session.created/updated{info:{id,parentID?,...}}`, `message.updated{info: Message}`, `message.part.updated{part, delta?}`, `permission.updated{id,type,pattern?,sessionID,messageID,callID?,title,metadata,time}`, `permission.replied{sessionID,permissionID,response}`, `question.asked{id,sessionID,questions,tool?}`, `question.replied{sessionID,requestID,answers}`, `question.rejected{sessionID,requestID}`.
- Subagents: `task` tool creates child session with `parentID`; same events; foreground-blocking by default; background only with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`; depth default 1.
- CLI: `opencode [project] --model/-m provider/model --agent name --session/-s id --continue/-c --fork --prompt text`; invalid/unknown `--session` → error, exit 1, no TUI. Session ids `ses_` + 26 chars.
- `opencode models [provider]` → `provider/model` per line (models.dev cache, may hit network); `opencode agent list` → `name (mode)` lines each followed by JSON permission block. Modes primary|subagent|all.
- No project trust prompt; default permission action `ask`. `OPENCODE_DISABLE_AUTOUPDATE=1` disables update checks (checks never self-install anyway). Mouse on by default.
