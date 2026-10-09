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
| Packaged macOS shell, helper, protocol, or lifetime | Focused desktop tests plus one relevant `agent:desktop` scenario against a freshly packaged app | Use visible native checks only for focus/window/dialog claims; signing, Gatekeeper, Intel, oldest macOS, and updates have separate gates. |
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
| `npm run test:package` | Publishable tarball creation, isolated global install under default npm lifecycle policy, installed native PTY TTY input/output/exit, desktop-dependency exclusion, command/version verification, authenticated bundled UI fetch, and graceful shutdown | Source-tree tests, browser interaction, provider PTY lifecycle, or real providers |
| `npm run test:windows-smoke` | Packaged CLI plus focused native Windows integration checks; fails off Windows and requires a prior build | Full root/web suites and the remaining native acceptance gate |
| `npm run web:test -- <paths...>` | Web UI Vitest tests, optionally focused by path | Root tests, Playwright |
| `npm run typecheck` | Runtime TypeScript | Web UI TypeScript |
| `npm run web:typecheck` | Web UI TypeScript | Runtime TypeScript |
| `npm run build` | Web UI typecheck and production bundle, runtime build, packaged build-identity check | Unit, integration, or E2E tests |
| `npm run check` | Instruction bridge, repository Biome check, runtime typecheck, release policy tests, and all root Vitest tests | Web UI tests/typecheck, Playwright, Agent Lab |
| `npm run test:release-policy` | Node-only release manifest and npm publication identity tests | Actual publication, signing, or application execution |
| `npm run web:e2e` | Automated Playwright smoke suite against a disposable runtime, development web server, and Git fixture | Production bundle startup, full Agent Lab scenario exploration, real providers |
| `npm run web:smoke:production` | Focused browser startup smoke against the production runtime and bundled UI, using an isolated fixture and existing `npm run build` output | Development web server, broader E2E scenarios, real providers |
| `npm run agent:lab` | Interactive isolated functional lane, fake provider by default | Automated unit-test coverage or permission to use a real provider |
| `npm run agent:desktop -- smoke --app <path>` | Isolated packaged macOS app, hidden by default, with synthetic data and fake provider | Signed-install/update acceptance, another architecture/OS version, or authorization for real providers |
| `npm --prefix desktop run check` | Desktop Biome, TypeScript, and Vitest checks | Root/web checks, actual packaged execution, signing, or Gatekeeper |

The pre-commit hook runs staged Biome followed by `npm run test:precommit`, which selects checks from NUL-delimited staged paths (including both sides of renames):

- Documentation-only edits skip code checks; changes to the canonical instruction bridge still run `check:agent-instructions`.
- Web-only and desktop-only edits run their own typecheck and unit suite. Runtime implementation edits run the runtime typecheck and `test:fast`.
- Test-only edits run the affected existing test files and their lane's typecheck. Deleted tests and changed test helpers fall back to the complete lane.
- Shared runtime contracts/configuration/diagnostics, browser-imported runtime helpers, shared tooling, dependency manifests, and unknown inputs take the conservative root, web, and desktop gates. These require independent dependencies in all three package directories.

The hook does not restage working-tree files. Account for its selected checks when choosing manual validation instead of repeating them on an unchanged tree. The selector in `scripts/precommit.mjs` is deliberately conservative; keep its ownership mapping current when adding cross-package imports. CI retains the complete platform matrix.

Pure web domain tests explicitly select the Node environment. Tests that require DOM rendering, browser event behavior, selection, or real React mounting retain jsdom. Do not infer environment from the `.ts` extension alone or disable module isolation globally. Focused web filters fail when they match no tests.

The 10,000-generation ownership traversal remains a real-filesystem integration stress test; the fast lane covers a smaller real chain. Desktop cleanup orchestration tests inject the polling wait and control deadline timers while asserting poll counts and fallback behavior. Production shutdown deadlines are unchanged.

`test:integration` and the root tests in `check` use Vitest's `integration` mode. Global setup compiles the current CLI and repeated IPC fixture entrypoints once into a disposable worktree-local directory, passes their paths through Vitest's provided context, and removes the build during teardown. Each case still starts fresh processes with its own state; no live runtime or previous build is reused. Plain `npm test -- <paths>` keeps the source/TSX path for focused iteration and comparison. Add `--mode integration` to opt a focused run into compilation. Source-bootstrap/import-safety cases deliberately remain source-based.

Package smoke uses a cold temporary npm cache by default. `npm run test:package -- --npm-cache <directory>` reuses only npm package downloads; installation roots, npm configuration, lifecycle policy, state, and native PTY checks remain isolated. CI passes its cached npm directory explicitly. Never share a mutable `node_modules` tree between worktrees.

CI runs the production build (which includes the web typecheck), `npm run check`, and web unit tests on Ubuntu, macOS, and Windows. The Ubuntu Node 22 row installs managed Chromium and runs `web:smoke:production` immediately after the build, reusing that output to check production runtime and bundled UI startup in an isolated browser fixture. Failed smoke runs upload the Playwright report and browser test results. The non-optional Windows job also fetches and gracefully stops the packaged CLI before the root gate, whose integration suite covers native ConPTY resize/reconnect/restore, long/case-sensitive Git paths, junction/copy worktrees, exact process ownership, DACLs, hook/status-line transport, host launch, and parent-disconnect shutdown. CI does not repeat the web typecheck as a separate step and keeps the development `web:e2e` suite and interactive Agent Lab exploration separate. Local validation should prove the change; it does not need to impersonate CI unless release or PR-readiness work explicitly calls for that gate. See the [native Windows guide](./windows-native-smoke.md) for the exact clean, focused, and manual commands.

For Windows-only iteration from a non-Windows host, dispatch the reusable `Test` workflow with `focused_windows=true` against the working branch. That lane installs only root dependencies and runs `test/integration/windows-native-smoke.integration.test.ts`; it is an inner-loop diagnostic and does not replace the final required CI matrix.

## Focused test selection

Choose test files by the owner changed, not by the size of the diff. Examples:

- A task classifier change starts with its classifier tests and one projection consumer.
- A transition-controller change starts with controller tests and the manager/API path that submits the event.
- A settings control starts with the settings form/domain test and the affected component test, not every web test.
- A recovery change uses the relevant startup or shutdown integration test; a browser refresh is not a substitute for a cold runtime restart.

If a focused run fails because another test is genuinely coupled to the changed contract, expand to that boundary and document what the failure revealed. Do not expand merely to produce a longer passing test list.

## Choosing a heavy lane

Use `web:smoke:production` after `npm run build` for the narrow production runtime and bundled UI startup gate. Use `web:e2e` for repeatable, automated browser smoke behavior already represented by its disposable development fixture. Use the repo-owned `quarterdeck-functional-testing` skill and Agent Lab for interactive browser, terminal, Git, Files, lifecycle, persistence, host-integration, or visual behavior that needs scenario control or diagnostic evidence.

For a packaged macOS boundary, the same skill routes to `agent:desktop`. Keep routine tests hidden; `--show-window` is reserved for native visibility/focus checks. Its lab-only mock keychain avoids modifying the user's macOS keychain. Record the actual app manifest and build identity, and inspect cleanup evidence even when the scenario fails. See the [desktop ledger](./desktop-validation.md) for gates that a synthetic unsigned run cannot establish.

Packaged runs require native application, local socket, and process-inspection permission from the task runner. A restricted host sandbox can abort macOS application registration before Quarterdeck starts, displaying a system crash alert even for a hidden window. The driver checks process inspection before spawning Electron; if denied, use scoped permission for the isolated test rather than retrying the restricted launch. Hidden windows do not suppress macOS crash dialogs. The full fake smoke deliberately crashes the renderer to test recovery; use `--manual-shells --no-agent` or `--performance` for their separate checks without deliberate crashes. Explain possible system alerts before running an intentional crash scenario, and never change global crash-reporting settings to hide test effects.

Within Agent Lab:

- default to the deterministic fake provider;
- exercise only the scenario needed for the changed behavior;
- drive the isolated UI through the repo-owned `npm run agent:browser` Playwright wrapper even when an in-app Browser connector is unavailable; connector availability and Computer Use do not determine whether Agent Lab can be automated;
- use `restart-runtime` only for cold hydration, persistence, startup recovery, or exact-session restore claims;
- collect screenshots only for visual claims;
- capture extra traces, console, network, or checkpoints when needed to explain a failure, not as ceremony for every passing run; and
- always stop the run.

Do not report that Agent Lab browser automation is unavailable until the repo-owned wrapper itself has been invoked against the run's `browserConfigPath`, `browserSession`, and `projectUrl` and its failure inspected. If the wrapper reports that managed Chromium is missing, install it automatically with `npm run agent:browser -- install-browser chromium`. Managed browser installation into the shared Agent Lab cache is part of authorized testing and requires no separate confirmation. Do not substitute direct `playwright-cli`, ad hoc Playwright scripts, an unrelated browser profile, or the user's active Quarterdeck instance.

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
