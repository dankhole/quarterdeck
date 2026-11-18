# Desktop-only product implementation

> Completed implementation plan, retained for rationale rather than current instructions. Current operation and migration guidance live in [Desktop](../desktop.md), validation policy in [Testing](../testing.md), and unresolved native/public-release gates in [Desktop acceptance](../desktop-validation.md).

## Decision and boundary

Quarterdeck becomes a macOS/Windows desktop product. Remove the standalone browser product, not the web technology inside Electron or the internal headless execution used by development, diagnostics, CI, and Agent Lab. Linux remains useful for shared source checks; it is no longer a supported graphical product target. Existing native-platform acceptance gaps remain explicit; this change does not certify untested platforms or publish a release.

The React renderer, local HTTP/WebSocket runtime, authenticated desktop admission, provider hooks, durable state, diagnostics, hidden Electron runs, synthetic fixtures, and normal shutdown/recovery safeguards must survive. Do not touch an active user instance, launch real providers, commit, publish, or change global installation state.

## Implementation sequence and ownership

### Launch and installation

Make the ordinary CLI launch the installed desktop app or fail with actionable platform/session/installation guidance. Remove `--browser`, browser auto-opening and URL printing, saved browser installation preferences, and browser opt-out lifecycle behavior. Source development and synthetic tests must still be able to start internal runtimes explicitly, without accidentally creating a supported browser product or weakening authentication. Preserve management subcommands, native installation admission, ownership checks, and paired updates. Existing apps must retain their `QUARTERDECK_INSTALL_MODE=desktop` update handoff and the existing `desktop status --json`/owner/receipt shapes. Explicit legacy browser installation settings warn and cease opting out; obsolete saved preferences are ignored, not a second policy mechanism. Remove obsolete installer/launch tests and replace them with desktop-only policy and internal-runtime regressions.

### Runtime and authentication

Remove browser bootstrap URLs, cookie sessions, browser attachment capabilities and management operations, unauthenticated/standalone product HTML access, and browser launch control messages. Keep runtime asset serving and startup asset checks: Electron's `app://quarterdeck` proxy still requests those files with desktop credentials. Preserve authenticated desktop HTTP/WebSocket access, scoped management access, hooks, diagnostics, exact runtime ownership, shutdown, and recovery. Update the runtime and private desktop IPC contract versions and exact schemas together when their contracts change. Persisted descriptors from older versions must remain readable enough to report an incompatible live runtime, not disappear behind a generic not-ready wait; keep ownership-claim/custody history compatible. Add negative coverage for removed bootstrap/cookie access and ordinary unauthenticated clients, alongside positive desktop/management coverage.

### Renderer and native shell

Remove the native Open in Browser command and browser-only renderer behavior: service-worker/offline support, browser environment resolution, non-native product integration fallbacks, browser notification delivery, and browser-only recovery paths where genuinely obsolete. Keep external links, clipboard/editor features, shared UI unit coverage, desktop bridge validation, native notification behavior, and renderer recovery. Remove code only after checking its desktop consumers; names containing `browser` are not evidence that code is obsolete.

### Internal tooling and coverage

Remove the standalone-browser product test lane and desktop/browser coexistence scenarios. Retain reusable synthetic providers, process isolation, headless packaged Electron automation, snapshots, cleanup, and desktop-only performance measurement. Reject competing performance scenarios before launch, keep diagnostic capture out of measurement sampling, and record ordinary checkpoint capture failures without changing scenario outcomes. Audit each removed end-to-end scenario: migrate meaningful desktop invariants into the packaged desktop harness or retain equivalent shared tests; do not silently discard unique coverage. Negative lifecycle assertions (bare Escape and historical interruption redraw) require bounded observation, not immediate snapshots or optional production-disabled terminal dumps. Retire browser-only launch tools and development scripts when they no longer have a real internal consumer. Keep source renderer iteration through build/component tests and a local Electron candidate, but not a public runtime escape hatch. Retiring the old interactive standalone-browser lab is distinct from preserving hidden packaged Electron scenarios and isolated source-runtime tests; document that command/workflow change explicitly. Packed npm smoke must avoid installing into the user's real desktop location and must still verify package identity, installed PTY operation, management/desktop admission where applicable, and graceful cleanup.

### Integration, workflows and documentation

Reconcile package scripts, dependency manifests/lockfiles, CI, release-policy checks, and packaging with desktop-only support. Keep shared Linux CI checks where useful; remove public browser-only release branches/defaults. Preserve immutable publication, exact source/artifact identity, both native release architectures, and optional signing policy. Update installation, upgrade, development, testing, functional-testing skill, and release guidance. Explain that prior browser users must save unsaved profile data, close old tabs (clear old site data if a retired service worker keeps refreshing), and install desktop. Existing durable data stays in the canonical state home, old browser preferences no longer opt out, and Linux/headless standalone product access ends. Document unsigned Windows/SmartScreen and ad-hoc macOS/managed-policy limits; removal of browser fallback does not make those OS restrictions disappear. Do not rewrite archived evidence as current validation.

## Parallel execution and review

Use disjoint implementation ownership: launch/install; runtime/contracts; renderer/native shell; internal tooling. The lead owns integration metadata, workflows, and current documentation. An independent reviewer examines this plan while implementation starts, prioritizing missed consumers, security boundaries, migration hazards and lost coverage. Route findings to the relevant owner and verify incorporation.

After integration, run independent reviews in parallel for runtime/security/lifecycle correctness and product-removal/tooling/coverage completeness. Address actionable findings and re-run only affected checks. Keep unresolved native OS/public-release acceptance separate from code validation.

## Validation and completion criteria

Use worktree-local dependency directories, never shared symlinks. Run focused root, web and desktop tests for changed behavior plus their typechecks and release/tooling policy tests; use one reconciled production build rather than repeated umbrella gates. Run the isolated packaged fake-agent desktop lane if a fresh local candidate can be built safely, always retaining identity/cleanup evidence. No real providers are authorized. Report blockers honestly rather than treating source tests as native Windows or public-install proof.

Completion requires no supported user-facing browser launch/install/attachment path, no obsolete browser-only release or CI lane, intact internal headless testing and desktop runtime security, explicit migration guidance, preserved meaningful functional coverage, and reviewed implementation with recorded validation limits. The current operating contract belongs in its owning guides; this completed plan is archived.
