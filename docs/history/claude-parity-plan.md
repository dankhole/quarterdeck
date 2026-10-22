# Claude Parity Plan

Completed plan, archived 2026-10-22. It closed the gaps where Claude Code task-agent support lagged Codex, starting from base commit `599f679e`, and landed on `feature/claude-parity` (`56d4855a`, `52621317`, `791f119d`). Mid-run additions not described below: the lean `hooks.js` entrypoint, HTTP best-effort Claude hooks, hook ingest latency fixes, and per-agent Claude and Codex subagent Needs Input waits. Current contracts live in [session lifecycle](../conventions/session-lifecycle.md), [runtime state](../conventions/runtime-state.md), [usage](../usage.md), and the [provider watchlist](../compatibility-watchlist.md). Remaining real-provider validation and follow-ups are tracked in the local Chit backlog.

## Scope

| # | Gap | Workstream |
| --- | --- | --- |
| 1 | Failed stored-id Claude resume can auto-restart on terminal reconnect | A |
| 2 | Esc interrupt leaves a Claude task Running | A |
| 3 | Helper text generation (titles, branches, commits, summaries) is Codex-login-only | C |
| 4 | No per-task Claude model / effort selection | B |
| 5 | "Copy full conversation" is Codex-only | D |
| 6 | Claude `/rename` custom titles are not followed | D |
| 7 | Claude workspace-trust driver lacks Codex's hardening | A |
| 9 | Claude hook-builder test, hook timeouts, compatibility watchlist | E |

Deferred (not in this plan):

- Gap 8, single-key Claude approval answers recorded as submissions: needs real-provider confirmation of Claude's select-key behavior.
- Claude cases for Codex-gated terminal copy/link/wheel policies: needs real-provider confirmation that Claude fullscreen mishandles them.
- Agent Lab fake Claude history provider and structured Claude turn recovery (SDK has no turn identity).

No real provider is used. All behavior is proven with fakes and focused tests; real-provider confirmation of rendered text and CLI flags is listed as a residual risk.

## Cross-cutting decisions

- **Additive contracts.** New browser/runtime fields are optional. Follow `DEVELOPMENT.md#browserruntime-compatibility`: bump `QUARTERDECK_RUNTIME_PROTOCOL_VERSION` only if an older runtime would reject a new browser payload (for example a strict command schema) or an older browser would break; otherwise keep the version and add a fallback test.
- **Provider policy stays separate from correctness.** Caching of helper availability or failure belongs in the helper, not in callers.
- **Lifecycle evidence.** Rendered-screen detectors may only remove Running or a current wait; they never assert work (`docs/conventions/session-lifecycle.md`).
- **Docs.** Each workstream updates the owning guide for behavior it changes (`docs/usage.md`, `docs/conventions/session-lifecycle.md`, `docs/conventions/runtime-state.md`, `docs/compatibility-watchlist.md`). No changelog entries.

## Workstream A — Claude lifecycle correctness (gaps 1, 2, 7)

Owned files: `src/terminal/codex-resume-failure.ts` (generalize or add a provider-neutral helper), `src/terminal/session-lifecycle.ts` (`recoverStaleSession`), `src/server/task-session-start-service.ts` (`hasFailedStoredCodexResume` only), new `src/terminal/claude-turn-interruption.ts`, `claudeAdapter` output-transition fields in `src/terminal/agent-session-adapters.ts`, `src/terminal/session-state-machine.ts`, `src/terminal/session-workspace-trust.ts`, `src/terminal/claude-workspace-trust.ts`, `src/terminal/session-input-pipeline.ts`.

1. **Resume-failure guard.** Make the reconnect auto-restart guard and the start-service failed-resume check provider-neutral for Claude, Codex, and Pi stored-id resume failures (`STORED_CLAUDE_RESUME_FAILED_WARNING` etc.). Mirror the Codex regression test (`test/runtime/terminal/session-manager-auto-restart.test.ts`, "does not reconnect-auto-restart a failed Codex stored-id resume") for Claude and Pi, driving `recoverStaleSession`.
2. **Rendered Esc-interrupt detector.** Add a bounded Claude detector modeled on `codex-turn-interruption.ts`: recognize Claude's interruption result (`⎿  Interrupted · What should Claude do instead?`) as the latest result immediately above Claude's active composer, in the visible viewport only. Historical/transcript text must stay inert. Applies only while Running from a current launch (add `canApplyClaudeRenderedTurnInterruption` beside the Codex predicate) and transitions to Review/Interrupted. Wire through `detectOutputTransition` + `shouldInspectOutputForTransition` so inspection is skipped outside Running. Update the Escape test in `session-manager-interrupt-recovery.test.ts` and document the detector in the session-lifecycle guide's rendered-evidence section.
3. **Workspace-trust hardening.** Give the Claude driver the Codex guards: unchanged-output check before sending keys, cancel on direct user input, stop after `wasInterrupted()`, and retire the observer once native hook work is confirmed. Tighten the matcher so both trust options must be adjacent rows of one dialog.

## Workstream B — Per-task Claude model and effort (gap 4)

Owned files: `src/core/api/board.ts`, every `codexOptions` carrier (`src/core/api/task-lifecycle.ts`, `src/core/api/project-board-command.ts`, `src/core/project-board-command.ts`, `src/core/task-board-mutations.ts`, `src/server/task-session-start-service.ts` pass-through, `src/terminal/session-lifecycle.ts` pass-through, `src/terminal/session-manager-types.ts`), the `claudeAdapter` args in `agent-session-adapters.ts`, and web UI task creation/editing (`task-create-dialog.tsx`, new `task-claude-options.tsx`, `use-task-editor.ts`, `task-editor-drafts.ts`, `use-task-start-actions.ts`, `project-board-command-sync.ts`, `board-state-parser.ts`, `board-state.ts`, `types/board.ts`, `app-dialogs.tsx`).

1. Add optional `claudeOptions: { model?, effort? }` beside `codexOptions` (additive; no rename of `codexOptions`, no migration). `effort` is an enum of Claude CLI levels `low | medium | high | xhigh | max`; `model` reuses the Codex model-id validation.
2. Static, shared Claude model choices (Default/inherit, `fable`, `opus`, `sonnet`, `haiku`) in a shared contract module the browser can import. No catalog endpoint.
3. Launch: `--model` / `--effort` in `claudeAdapter`, skipped when the user's configured agent args already contain them. Match Codex semantics for whether options apply on resume.
4. UI mirrors `task-codex-options.tsx` for `agentId === "claude"`; drafts and parser preserve `claudeOptions` only for Claude, exactly as they do for Codex.
5. Tests: schema/round-trip through board commands, adapter arg construction, drafts/parser, and the options component.

## Workstream C — Claude helper text generation (gap 3)

Owned files: new `src/title/claude-client.ts`, `src/title/generation-helper.ts`, `src/title/title-generator.ts`, `src/title/index.ts`, `src/config/agent-registry.ts` (`textGenerationAvailable` only), `web-ui/src/components/settings/display-sections.tsx` copy, `docs/usage.md` helper section.

1. `claude-client.ts` mirrors `codex-client.ts` (injectable executor, stdin delivery, timeout termination, launch admission, bounded output, sanitized response). Invocation: one-shot `claude -p` with `--output-format json`, `--model haiku`, `--no-session-persistence`, `--tools ""`, an explicit `--system-prompt`, no user hooks/plugins/project settings, `cwd` = temp dir. Verify each flag against `claude --help`; `--bare` may change authentication, so use it only if it keeps the user's normal Claude login.
2. Provider order: Codex login → Claude login → configured gateway. Existing Codex users see no change; Claude-only users get generated text. `QUARTERDECK_TITLE_PROVIDER` additionally accepts `claude`.
3. Availability: binary on PATH at the minimum Claude version. When a call fails for auth reasons, back off Claude for a bounded period so every title does not pay a failed launch.
4. Update Settings copy and `docs/usage.md`. Tests use the injected executor only.

## Workstream D — Claude transcript features (gaps 5, 6)

Owned files: new `src/conversation/claude-conversation-export.ts`, `src/trpc/handlers/read-task-conversation.ts`, `web-ui/src/components/app/connected-top-bar.tsx` (gate), `web-ui/src/hooks/terminal/use-copy-conversation.ts` (copy), new Claude title monitor (`src/server/claude-task-title-monitor.ts` + a reader beside `src/title/codex-thread-names.ts`) and its server wiring, `src/server/automatic-task-title-scheduler.ts`, `docs/usage.md` copy section, `docs/conventions/runtime-state.md` title section.

1. **Export.** Export the full Claude conversation from the task's exact session JSONL (found through the existing provider source locator and lineage checks), reusing `claude-history-parser.ts` / `claude-history-reconstruction.ts` for the active chain. Keep the Codex export's size limits, error taxonomy, and identity checks. Enable the copy button and handler for Claude.
2. **Custom titles.** Follow Claude's latest `custom-title` JSONL entry for the task's exact session (not `summary` entries). Adopt it through the same board command path and manual-edit fencing as Codex thread names. Claude keeps its generated initial title; only an explicit `/rename` replaces it.

## Workstream E — Claude hooks hardening and docs (gap 9)

Owned files: `src/claude-hooks.ts`, new `test/runtime/claude-hooks.test.ts`, `docs/compatibility-watchlist.md`.

1. Add explicit per-hook `timeout` values matching Codex's bounds, after confirming in `src/commands/hooks.ts` that no Claude hook command is expected to block longer.
2. Unit-test `buildClaudeHooksSettings`: subscribed events and matchers, statusline toggle, timeouts, command shape.
3. Add a Claude section to the compatibility watchlist: hook event names/payload fields relied on, `StopFailure`, permission/elicitation hooks, fullscreen renderer env contract, rendered interruption and trust text, helper CLI flags.

## Validation

Each workstream runs focused root/web tests for its files plus `npm run typecheck` / `npm run web:typecheck` for touched lanes. After merging all workstreams: `npm run check` and the affected web suites once on the reconciled tree. No Agent Lab or real-provider runs.

## Residual risks

- Claude's rendered interruption and trust-dialog text and the helper CLI flags are matched against current Claude Code (2.1.x) from documentation and help output, not a live provider run.
- Claude model aliases change over time; the static list must be kept current.
