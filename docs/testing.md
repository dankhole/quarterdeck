# Testing Strategy

Quarterdeck has several validation layers because its behavior spans pure domain logic, a long-lived runtime, a browser client, PTYs, persistence, and external agent providers. Use the smallest layer that proves the changed invariant. More testing is useful only when it covers a distinct risk.

This document owns test selection. [`DEVELOPMENT.md`](../DEVELOPMENT.md) lists developer commands, [`test/README.md`](../test/README.md) owns root-test placement, and [`agent-functional-testing.md`](./agent-functional-testing.md) documents Agent Lab operation.

## Selection rules

- Start from the changed ownership boundary and the failure the test must detect.
- Prefer focused tests while implementing. Add one caller-path test when a pure unit test would miss wiring or ownership mistakes.
- Do not run an umbrella command and all of its constituent commands on the same unchanged tree.
- Re-run only validation affected by files changed since the last successful run.
- Reconcile or merge the final base before any broad final gate. A pre-merge full run does not validate the merged tree.
- Do not repeat validation after a squash or history-only rewrite when the resulting tree is identical.
- Treat documentation-only work as documentation work. It does not invalidate runtime or browser behavior.
- In the handoff, report what ran, why it was selected, and any relevant layer deliberately not used.

## Change-to-validation guide

| Changed boundary | Default validation | Escalate when |
| --- | --- | --- |
| Pure reducer, classifier, parser, or utility | Focused unit tests | Add one real caller-path test if integration or ownership wiring could be wrong. |
| Hook ingest, ordering, or state transition | Focused reducer plus API, manager, or controller tests | Add cross-process coverage when timing, persistence, or restart behavior changes. |
| Persistence, shutdown, startup, or recovery | Focused integration test that crosses the relevant process or filesystem boundary | Use Agent Lab cold restart only when the browser-visible projection or PTY recovery is part of the claim. |
| UI component, hook, or projection | Targeted web unit/integration tests | Run the complete web suite only for broad shared-state, provider, or application-shell changes. |
| CLI or launcher composition | Focused executable, adapter, or argument-construction tests | Use a real provider only when its actual CLI rejects or interprets the generated invocation differently from the fake. |
| Browser/runtime/PTY convergence | One narrow deterministic Agent Lab scenario | Add more scenarios only for separate regression classes. |
| Provider TUI, hook schema, event ordering, version compatibility, or launcher uncertainty | One narrow, explicitly authorized real-provider Agent Lab scenario | Keep fake coverage for deterministic product behavior; never make the real lane a general regression suite. |
| Visual layout, clipping, paint, stacking, contrast, or responsive behavior | Pixel screenshot at the affected viewport plus semantic state | Skip screenshots for lifecycle or semantic bugs whose visual rendering is not disputed. |
| Documentation only | Formatting, `check:agent-instructions` when its bridge changed, and validation of links added or changed | Run code tests only when documentation tooling or executable examples changed. |
| Broad final integration or release readiness | One appropriate umbrella gate on the final reconciled tree | Add web, E2E, or provider lanes only when those surfaces changed or the release gate requires them. |

## Command scopes

| Command | Actual scope | Not included |
| --- | --- | --- |
| `npm run check:agent-instructions` | `AGENTS.md`/`CLAUDE.md` bridge shape and routing checks | Formatting, types, or product tests |
| `npm run test -- <paths...>` | Root Vitest tests, optionally focused by path | Web UI tests |
| `npm run test:fast` | `test/runtime` and `test/utilities` | `test/integration`, web UI tests |
| `npm run test:integration` | `test/integration` | Runtime unit tests, web UI tests |
| `npm run web:test -- <paths...>` | Web UI Vitest tests, optionally focused by path | Root tests, Playwright |
| `npm run typecheck` | Runtime TypeScript | Web UI TypeScript |
| `npm run web:typecheck` | Web UI TypeScript | Runtime TypeScript |
| `npm run build` | Web UI typecheck and production bundle, runtime build, packaged build-identity check | Unit, integration, or E2E tests |
| `npm run check` | Instruction bridge, repository Biome check, runtime typecheck, and all root Vitest tests | Web UI tests/typecheck, Playwright, Agent Lab |
| `npm run web:e2e` | Automated Playwright smoke suite against a disposable runtime and Git fixture | Full Agent Lab scenario exploration, real providers |
| `npm run agent:lab` | Interactive isolated functional lane, fake provider by default | Automated unit-test coverage or permission to use a real provider |

The pre-commit hook already runs staged Biome, the runtime typecheck, and `test:fast`. Account for that when choosing manual pre-commit validation instead of repeating it on an unchanged tree.

CI currently runs the production build (which includes the web typecheck), `npm run check`, and web unit tests on Ubuntu and macOS. It does not repeat the web typecheck as a separate step, and it does not run `web:e2e`, Agent Lab, or a Windows lane. Local validation should prove the change; it does not need to impersonate CI unless release or PR-readiness work explicitly calls for that gate.

## Focused test selection

Choose test files by the owner changed, not by the size of the diff. Examples:

- A task classifier change starts with its classifier tests and one projection consumer.
- A transition-controller change starts with controller tests and the manager/API path that submits the event.
- A settings control starts with the settings form/domain test and the affected component test, not every web test.
- A recovery change uses the relevant startup or shutdown integration test; a browser refresh is not a substitute for a cold runtime restart.

If a focused run fails because another test is genuinely coupled to the changed contract, expand to that boundary and document what the failure revealed. Do not expand merely to produce a longer passing test list.

## Choosing a heavy lane

Use `web:e2e` for repeatable, automated browser smoke behavior already represented by its disposable fixture. Use the repo-owned `quarterdeck-functional-testing` skill and Agent Lab for interactive browser, terminal, Git, Files, lifecycle, persistence, host-integration, or visual behavior that needs scenario control or diagnostic evidence.

Within Agent Lab:

- default to the deterministic fake provider;
- exercise only the scenario needed for the changed behavior;
- drive the isolated UI through the repo-owned `npm run agent:browser` Playwright wrapper even when an in-app Browser connector is unavailable; connector availability and Computer Use do not determine whether Agent Lab can be automated;
- use `restart-runtime` only for cold hydration, persistence, startup recovery, or exact-session restore claims;
- collect screenshots only for visual claims;
- capture extra traces, console, network, or checkpoints when needed to explain a failure, not as ceremony for every passing run; and
- always stop the run.

Do not report that Agent Lab browser automation is unavailable until the repo-owned wrapper itself has been invoked against the run's `browserConfigPath`, `browserSession`, and `projectUrl` and its failure inspected. If the wrapper reports that managed Chromium is missing, ask before installing it with `npm run agent:browser -- install-browser chromium`. Do not substitute direct `playwright-cli`, ad hoc Playwright scripts, an unrelated browser profile, or the user's active Quarterdeck instance.

Use `real-codex` or `real-claude` only with explicit user authorization and only when the uncertainty is that provider's real TUI, hooks, event ordering, version compatibility, or launcher interpretation. A real-provider run is nondeterministic and consumes the user's provider plan; it is not a stronger default version of a fake lane. Interactive Claude has no hard budget cap, so its low-cost `haiku` default and a tiny prompt reduce cost without enforcing a ceiling.

Never attach browser automation to the user's active Quarterdeck instance. Agent-driven functional work uses the isolated lab and synthetic data.

## Final validation and reporting

Before a broad final gate, confirm that base reconciliation is complete and identify what earlier successful evidence remains valid. Then run each required layer once.

A useful handoff states:

1. focused tests and static checks run;
2. integration, web, E2E, or Agent Lab scenarios run, if any;
3. why each heavy layer was necessary;
4. relevant validation intentionally skipped; and
5. whether validation applies to the final reconciled tree.
