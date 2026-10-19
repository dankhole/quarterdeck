# Desktop update discovery and npm handoff

> Frozen historical snapshot archived on 2026-10-19. This document preserves the original design or candidate evidence, including superseded proposals and status at the time. Use the [current desktop guide](../desktop.md), [release runbook](../desktop-release.md), and [current acceptance gates](../desktop-validation.md) for development and release decisions.

Implement explicit app-driven npm updates on top of the shared installer. npm remains the only update authority. This plan is an implementation handoff, not a task tracker or a claim of release validation.

## User behavior

An installed npm-owned app checks the public npm registry once after startup and when the user chooses **Check for Updates**. Stable versions follow `latest`; prerelease versions follow `preview`. Compare semantic versions, never downgrade, and pin the checked version for execution rather than executing a moving tag. A local linked build shows its checkout's existing `npm run link` guidance and never requests release metadata. Unmanaged and synthetic apps do not perform production checks or updates.

An available update adds an accessible **Update available · vX.Y.Z** control to the desktop product chrome and changes the native update-menu label. No automatic modal, recurring timer, OS notification, or repeated launch popup is added. Clicking the control opens native details with installed/available versions, the owning npm prefix, release notes, and **Update Quarterdeck**. Automatic offline/registry failures stay quiet; an explicit check explains failures or that the installed version is current. A failed refresh must not authorize a stale target.

## Ownership and checks

Keep registry retrieval, version comparison, presentation, and update execution separate. Registry calls use a fixed public HTTPS origin, no user credentials, bounded response bodies and deadlines, validated package/version metadata, and no redirect to an arbitrary host. Only one check runs at a time. Startup completion cannot overwrite a newer explicit result, and disposing the app invalidates late callbacks. No persistent cache is required for correctness.

The main process owns update state. A separate optional `quarterdeckDesktopUpdates` preload namespace exposes a sanitized snapshot, snapshot subscriptions, and fixed `check`/`details` intents. Keep the original desktop bridge's exact shape because compatible older runtime UIs validate its keys strictly. Renderer messages cannot supply paths, versions, package names, executable arguments, or commands. Apply existing frame/document/runtime-generation admission on every IPC operation. Browser-only clients render nothing; older bridges remain compatible.

## Explicit update transaction

1. Revalidate the recorded owning slot and the checked target before handoff. Resolve a usable external Node/npm toolchain from trusted desktop launch configuration, independently of bundled Node. Reject executables inside the app or the package being replaced, unsupported versions, ambiguous owners, or missing tools with exact manual guidance. npm lifecycle PATH must also resolve this external Node and exclude replaceable trees. Do not require sudo or change npm configuration/script permissions.
2. Prepare a private, bounded one-shot runner outside both replaceable trees. It contains code and validated request metadata, never copied credentials. Launch its fixed command through macOS Terminal so progress and failure remain visible after Quarterdeck exits. Use fixed argv and safe quoting, never execute registry or receipt text as shell code. Runner readiness must be acknowledged before app shutdown begins.
3. Show the exact target and explain that normal app-owned session shutdown is required. Use the existing draft/session quit coordinator with an update reason that cannot accept forced/unconfirmed cleanup. Cancelled or failed preflight cancels the pending runner without touching npm. Serialize update intent against ordinary Quit, restart, environment refresh, and repeated clicks.
4. Arm the ready runner only after clean shutdown, then renew or verify the final draft seal after the asynchronous acknowledgement. Arming alone cannot run npm: send the final commit synchronously with app quit after a clean coordinator result. Cancellation before this commit must remain safe even if temporary-file writes fail. Failure after stopping the runtime must expose runtime recovery instead of leaving an apparently active product surface. The committed runner waits for the initiating app to exit before invoking npm, with a bounded wait and safe cancellation if the parent disappears without commit. It rechecks the original owner immediately before mutation. It never kills a user runtime or provider. Do not inherit the app's native admission descriptor or rely on bundle code after replacement starts.
5. Execute the exact selected version in the recorded prefix, using the public registry checked above and foreground lifecycle output. Existing npm script policy remains effective. The shared installer retains download/signature checks, native replacement admission, rollback, and incomplete-pair detection. If another app starts during handoff, safe refusal and explicit repair guidance remain authoritative; do not claim an atomic npm/app transaction.
6. On npm success, invoke the new package's read-only machine-readable desktop status and require the expected version, owner/prefix, ready state, and no pending transaction. Skipped hooks or partial updates are failures, even with npm exit zero. Keep failure output visible with an exact pinned retry command. Report success with instructions to reopen the app; no automatic relaunch, persistent helper, background scheduler, or hidden retry loop.
7. Cancelled and successful temporary handoffs remove their private files. Failed/abandoned handoffs must be bounded and reported, with conservative cleanup of only recognized owned files; no permanent history of runners or app versions.

## Code ownership

- Shared update contract: bounded public snapshot and intent schemas.
- Registry service: fixed-origin metadata retrieval and semantic version/channel decisions, with injectable transport for tests.
- Native update controller: state/check orchestration, details, revalidation, and clean-quit/handoff coordination; main remains composition only.
- One-shot npm runner: external toolchain validation, prepared/authorized/cancelled handoff, visible Terminal execution, result verification and cleanup.
- Existing desktop bridge and product chrome: typed snapshots/intents and the visible available-version control.
- CLI desktop status: additive JSON mode for non-mutating post-update verification.

Keep the existing private Electron package, shared runtime, project storage, native installer gate, and owning-prefix receipt contracts. Do not reintroduce Electron autoUpdater or a second download/replacement engine.

## Validation and review

Parallel implementation owns disjoint modules. An independent architecture review checks this plan while implementation starts; final independent reviews cover the update-execution/quit boundary and registry/IPC/UI behavior. Resolve every concrete finding before completion.

Tests cover semantic version ordering/prereleases, equal/newer-installed versions, bounded/offline/malformed/redirected responses, deduplication/disposal, linked/synthetic suppression, stale target invalidation, IPC sender checks and payload rejection, browser fallback, accessible indication, and subscription cleanup. Runner integration uses fake npm in a private synthetic prefix, never a real global update. Prove readiness, cancellation, missing external Node/npm, owner changes, parent exit, paths with spaces/quotes, exit-zero mismatches, disabled hooks, success, failure, and private cleanup. Confirm update cannot proceed after forced/unconfirmed quit or another transition.

Run affected root/desktop/web tests and typechecks, a paired build, and a relevant isolated packaged fake-provider/fixture scenario when behavior cannot be established below that layer. Use the repo-owned functional-testing skill for Agent Lab, synthetic data only, and always inspect cleanup. Do not mutate the installed app, Dock, main checkout, npm prefix, or real sessions during development. Actual signed public version-to-version updates and Terminal/Gatekeeper acceptance remain explicitly recorded release gates until executed.
