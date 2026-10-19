# Unified Quarterdeck installation plan

Make Quarterdeck one installed product with desktop and browser launch modes. On supported Macs, `npm install -g quarterdeck` installs the command and the app, and `npm run link` builds and installs the current checkout through the same installer. The Dock icon and command open the same permanent app. npm owns published updates; local development uses the linked checkout.

This is a design and implementation handoff, dated 2026-10-19. It does not describe shipped behavior. It replaces the installation and updater proposals in the earlier [macOS desktop plan](./macos-desktop-plan.md); the current [desktop architecture](./desktop.md), runtime ownership, and storage contracts remain the implementation baseline. Execution status belongs in the primary checkout's Chit list, not in a second Markdown task tracker.

## Product behavior

| Entry point | Intended behavior |
| --- | --- |
| `npm install -g quarterdeck` on a supported Mac | Install the CLI and attempt installation of the exact matching signed app, without launching it. |
| `npm run link` on a supported Mac | Prepare dependencies, build one paired runtime and UI, package the native app, link the CLI, and complete installation through the shared installer. |
| `quarterdeck` in a local macOS graphical session | Validate the installation and open or activate its app, selecting the current project through the existing typed launch request. |
| Dock or Finder icon | Validate the same installation before starting or attaching to a runtime. |
| `quarterdeck --browser` | Use the existing browser/runtime launch path. Never install the app as a side effect. |
| `quarterdeck --desktop` | Explicit desktop launch; retain as a supported mode selector. |
| `quarterdeck desktop install` | Idempotently complete or repair installation for the invoking CLI. Never independently choose a newer npm version. |
| `quarterdeck desktop status` | Report installed identity, owning npm prefix or checkout, pending replacement, and concrete recovery action. No writes or downloads. |
| `quarterdeck desktop uninstall` | Explicitly remove the owned app and installation metadata after proving they are unused. Preserve all project and user data. |
| App update menu | Discover available npm versions and offer the confirmed npm handoff in the [update implementation plan](./desktop-update-plan.md), or show the owning checkout's `npm run link` command. No independent desktop updater. |

Use `~/Applications/Quarterdeck.app` as the canonical per-user app location. Keep installer metadata under `~/Library/Application Support/Quarterdeck/installation`, outside both the signed bundle and project state. Do not add a configurable installation path in the initial implementation. An existing app at the destination must be recognized as an owned Quarterdeck installation before replacement; an unrelated or unverifiable item is a conflict.

Linux, Windows, unsupported macOS versions, and unsupported architectures retain the CLI/browser product without downloading Electron. A supported Mac without a graphical session defaults to browser/runtime mode without automatically opening a browser; explicit `--desktop` explains the limitation. Runtime flags such as `--host`, `--port`, `--no-open`, and `--no-native-ui` select the existing runtime path when no mode was explicitly selected. Explicit desktop plus incompatible runtime flags remains an error. Specify and test this precedence rather than guessing from TTY availability alone.

Provide a documented installation opt-out, proposed as `QUARTERDECK_INSTALL_MODE=browser`, for supported Macs used only as CLI hosts. It affects installation, not durable product settings or future launch preferences. Local source dependency installation, CI dependency installation, and installation as another project's dependency must never install a user app. Root or ambiguous-user installations must not guess a home directory or change another user's Applications folder; report the supported user-owned npm-prefix setup.

Keep `npm run link -- --desktop` temporarily as a redundant compatibility alias. Provide `npm run link -- --browser` for deliberate CLI-only development. Keep `desktop:build` as the lower-level packaging command. Consolidate `desktop:install` onto the same orchestration, or deprecate it once internal callers migrate; it must not retain separate installation rules.

## Code boundaries to simplify

The runtime and product UI are already shared. Most separation to remove is installation, distribution policy, and entry-point orchestration.

| Boundary | Change | Preserve |
| --- | --- | --- |
| `src/desktop-install/` | Replace UUID installation slots and version selection pointers with one installed bundle, one bounded transaction, and one owning installation receipt. Keep one installer used by npm, CLI repair, and local builds. | Download validation, size/checksum checks, bundle identity, signatures, Gatekeeper checks, safe path handling, and typed errors. |
| `src/cli.ts`, `src/desktop-launcher.ts`, `src/commands/desktop.ts` | Extract a small shared launch-policy function; introduce status and explicit removal; apply consistent incomplete-install outcomes. | Subcommand isolation, typed project intent, authenticated runtime admission, and existing browser flags. |
| `scripts/dependency-workflow.mjs`, `scripts/desktop-local.mjs` | One local build/link/install orchestration, one paired build, and one installation completion check. | Dependency preparation, active-linked-runtime safeguards, and build-without-install commands. |
| `src/shared/desktop-launch-contract.ts` and installation identity contracts | Share bounded schemas and pure compatibility decisions across CLI and Electron startup. | Separation between package version, artifact/build identity, launch protocol, and runtime protocol. |
| `desktop/src/main.ts`, launch identity and menu modules | Compose shared installation preflight and npm update guidance through narrow adapters. | Electron lifecycle, window behavior, native menus/dialogs, environment setup, and private IPC. |
| Electron update modules and CLI update notification | Replace independent update policy with explicit npm guidance/checks; remove obsolete download/feed/restart orchestration and its dependencies after caller migration. | General Quit coordination, draft protection, runtime shutdown, and signature verification used by installation. |
| Packaging and release tooling | One release identity and required matching signed Mac artifacts for supported platforms. | Separate native architecture builds, exact dependency locks, bundled Node, and ABI validation. |

Keep `desktop/` as a private build package. Electron and bundled Node have different native-module requirements; merging their dependency trees would add risk without making the user experience simpler. Keep the npm runtime available for cross-platform browser use, diagnostics, hooks, and headless operation. Package the same runtime implementation inside the app; do not build a second runtime or replace the npm package with a Mac-only launcher.

Do not extract forwarding wrappers merely to reduce file size. Share real policy and state transitions. Runtime selection, board mutations, provider handling, host integrations, settings, and frontend product commands retain their existing owners. No new daemon, background update scheduler, runtime handoff system, or project-storage migration is part of this work.

## Installation identity and ownership

Use a versioned, private installation receipt containing the canonical app path, installation generation, source kind, global package slot and its resolved target, npm prefix or linked checkout, release/source identity, architecture, desktop artifact identity, and current completion state. Identifying the slot as well as its target detects a global symlink that has moved to another checkout. Persist no credentials or inherited environment. Keep transaction paths constrained to installer-owned locations and never execute a command supplied by receipt data. Every repair, transfer, and removal uses expected owner and generation checks so an older prefix cannot remove a newer owner's app.

Published pairing uses the immutable release version and source SHA, together with the verified architecture-specific artifact manifest. npm and the two desktop jobs currently generate separate random build IDs, so equality of those IDs is not a valid release invariant. Stamp release identity into the shipped npm artifact and compare it with signed desktop provenance. Retain each build ID and checksum for artifact verification. Local linking builds once and records the exact local paired build ID and native shell checksum; a same-version rebuild is a distinct installation.

One npm prefix or checkout owns the per-user app at a time. An ordinary launch from another prefix must report the conflict, not downgrade or overwrite the app. Ownership transfer is an explicit maintenance operation, proposed as `quarterdeck desktop install --replace-owner`, or a clearly reported deliberate `npm run link` from the new checkout. npm hooks never silently take ownership from a different prefix. A deliberate same-owner version pin can install an older version after normal checks; it does not imply that older runtimes can read newer persisted state. Preserve existing compatibility and migration protections and document that app rollback is not a data downgrade.

Make transfer reachable even when a rejected postinstall caused npm to remove the new CLI: install into the intended prefix with `QUARTERDECK_INSTALL_MODE=browser npm install -g quarterdeck@<version>`, then invoke that prefix's exact CLI path with `desktop install --replace-owner`. The opt-out only prepares the command; transfer still performs all verification, in-use, and expected-owner checks.

Dock startup reads the receipt and the recorded owner's installed package metadata directly; it does not invoke whichever `quarterdeck` happens to appear on PATH. Missing, changed, or unreadable owner metadata produces an installation-repair surface before runtime startup. Status, repair guidance, and diagnostics remain available. Explicit browser mode remains governed by runtime compatibility rather than an unrelated desktop installation failure.

Installation pairing and runtime attachment are separate checks. After the CLI and installed app are verified as a pair, attachment to an existing runtime still uses the established runtime, bridge, and transport protocols. Do not require equal build IDs for otherwise compatible browser/runtime attachment. Hook, statusline, backup, recover, diagnostics, version/help, and the internal desktop helper invocation must never recurse into the desktop-default launcher.

## Replacement transaction

The installer owns app replacement; npm still owns changes to its package and global command. There is no atomic transaction spanning both. The durable installation record and startup checks must detect both interrupted hooks and updates whose hooks never ran.

1. Resolve the invoking installation, requested version/source, native host architecture, and destination ownership. On Apple Silicon, handle an x64 Node process under Rosetta explicitly rather than blindly selecting `process.arch`.
2. Record each attempt's exact owner/process identity and allocated temporary paths before downloading or copying. Preparation may run concurrently and does not block ordinary app launches. Bound each download and use a conservative retained-stage threshold; this threshold is a resource policy, not a strict global concurrency limit. Serialize replacement and abandoned-stage cleanup under the native mutation gate. Reap only exact, proven-dead attempts, preserving live or unknown stages. Download or receive the candidate without touching the installed app. Enforce bounded download and extraction, verify manifest and payload, mount release containers read-only when required, and verify bundle/signature/Gatekeeper policy. Local builds follow the same path and identity checks but retain explicit development provenance; they do not pretend to be signed releases.
3. Stage the verified candidate on the destination filesystem. Revalidate the copied candidate, available space, permissions, and exact existing destination. Never edit a signed bundle to insert installation receipts.
4. Acquire one installation-wide mutation gate independent of `QUARTERDECK_STATE_HOME`. Recheck ownership, npm/local identity, and all app-use evidence immediately before replacement. If the app or a helper still uses the installation, return a typed quit-and-retry outcome. Do not signal, quit, or stop any process.
5. Durably record the intended replacement and the previous receipt. Move the old bundle to one temporary backup, promote the staged bundle to the stable path, verify the installed result, and atomically publish the completed receipt. Sync critical transaction metadata and directory changes where supported. A transaction interrupted between moves is recovered from its recorded identities, not path existence alone.
6. Remove the backup after verified app placement and receipt publication. The first explicit native launch opens the verified permanent path through LaunchServices; installation does not launch the app. Delete staging/download residue on normal completion or failure. A cleanup failure reports that installation completed with cleanup pending; the next explicit installer operation safely finishes it. Never accumulate a version history. Protocol-capable moved backups or obsolete managed copies must reject startup before spawning a helper; older binaries require the legacy migration safeguards below.

Use one small transaction journal with phases such as preparing, prepared, replacing, committed, and cleanup pending. Keep it separate from the long-lived installed receipt. Early allocation records allow the next installer to clean abandoned downloads and stages after proving the previous attempt stopped; do not accumulate untracked temporary directories or delete by age alone. Preparation does not invalidate an otherwise matching installed pair or prevent its launch. On failure before commit, restore the old bundle and receipt only after proving their identities and that no process is using the target. On failure after commit, preserve the verified new bundle and finish cleanup. If recovery cannot prove a safe action, leave the bounded evidence and show the recovery command instead of deleting uncertain files.

Rollback restores app installation files, not npm's package, the global symlink, or project data. If npm has already advanced, the restored old app remains mismatched and must refuse ordinary launch until repaired. If npm later fails or reverses part of its own operation, the app's owner check likewise catches that state. Repeating the same installation converges without creating another permanent copy.

## Launch and replacement concurrency

An Electron single-instance lock is scoped to its profile and cannot protect the installed bundle across multiple state homes. A process scan followed by rename also leaves a launch race.

Coordinate supported CLI, Dock, and helper entry points with the same installation gate. Register lifetime bundle-use evidence for Electron main and every bundled helper before allowing runtime startup or bundle-dependent child work. Serialize claim creation with replacement admission. Retain the helper claim independently so a main-process crash cannot permit replacing files under a surviving helper. Reuse existing host, boot, PID/birth, and process-inspection primitives; live or unverifiable evidence blocks replacement. Time elapsed or an absent parent PID is insufficient.

The first implementation milestone must prove the actual packaged Dock-launch race, including a launch during each replacement boundary. JavaScript startup checks alone do not prove that macOS cannot begin loading Electron during a swap. Prefer existing OS and process primitives; if they cannot establish safe early admission, add the smallest signed native bootstrap/OS-lock mechanism needed to acquire admission before bundle loading. Do not claim the race is solved by adding another `ps` check. This is a ship gate for permanent-path replacement, not permission to redesign runtime custody.

A launch that overlaps a replacement may show an updating/retry message and exit before creating sessions. A running, admitted app causes replacement to stop and ask the user to quit. Normal Quit retains existing unsaved-work and live-session decisions: an app-owned runtime stops through that path; an attached CLI-owned runtime survives. Session continuity across app replacement is not promised. No installer action may turn the user's refusal to quit into a forced shutdown.

## npm and local development orchestration

Add a small compiled postinstall entry point shipped in the npm tarball. It must run without source files, dev dependencies, Electron tooling, or runtime startup. Apply explicit global-install/platform/user policy before invoking the shared installer. Ordinary repository `npm install`/`npm ci`, dependency installation, and direct `npm link` must not unexpectedly trigger app replacement.

The hook is noninteractive and must not depend on visible progress output. If it runs and cannot complete required installation, return a nonzero result with a short reason and exact retry instruction. Do not assume npm preserves either the old or new CLI after failure. Recovery guidance must include rerunning `npm install -g quarterdeck@<version> --foreground-scripts`; when the CLI is usable, `quarterdeck desktop install` completes the same operation without a new version selection.

npm can suppress install scripts, and lifecycle output is not normally foreground output. Therefore a successful npm exit alone is not proof of a complete app installation. CLI and Dock preflight must detect absent or stale pairing even when no pending journal was written. Respect npm script permissions; never bypass them or alter the user's npm configuration. See [npm installation configuration](https://docs.npmjs.com/cli/v11/commands/npm-install/#ignore-scripts).

For `npm run link`, preflight the active linked checkout before dependency changes or rebuilding. Prepare and build once, package and verify, then coordinate the global link and app placement under the same pending/completed installation model. Recheck the globally resolved link and package identity before reporting success. A link failure must not report a completed pair. A failed app replacement after linking leaves explicit repair state. Preserve build-only commands for work that should not replace the daily app.

Keep install-time effects limited to the app and its installation metadata. Do not start runtimes, register projects, alter the Dock, rewrite shell startup files, change provider authentication, or require Git/provider availability just to install. Validate package scripts under the declared supported npm versions and their default policies; define the tested support range in setup documentation.

## One update policy

The initial installer exposed the exact npm update command and a copy action. The [update implementation plan](./desktop-update-plan.md) adds bounded startup/manual registry discovery, a visible available-version control, and an explicit pinned-version npm handoff after clean quit. Failure leaves the app usable or offers runtime recovery if shutdown already completed. The app never fetches an Electron update feed or accepts an arbitrary shell command. Display the owning prefix so a shell using another Node installation cannot be mistaken for the owner. Local builds show the owning checkout and `npm run link`, not an npm command that would replace development work.

Remove `autoUpdater` wiring, `DesktopUpdates`, feed discovery, `quitAndInstall`, installer-error recovery used only by that updater, and validation-feed inputs once their callers are migrated. Preserve generic Quit/reload/runtime-restart guards. Remove or replace the current periodic `update-notifier` path so there is no second background registry-check policy; retain `--no-update-notifier` as a compatibility no-op with appropriate help during transition if needed.

Replace updater enablement fields with installation/distribution provenance consistently in desktop packaging, artifact verification, shared schemas, installer metadata, release validators, workflow inputs, menus, and tests. Current stable-release validation requires `productionUpdatesEnabled`; disabling updater code alone would leave contradictory release gates. Keep signature/team, source/version, runtime identity, hardened-runtime, and fuse proofs that protect installation.

New releases have one supported installed ownership model. Signed download assets are inputs to the npm installer, not a second auto-updating product. A directly opened unmanaged candidate gets installation guidance; explicitly isolated development/lab candidates remain supported. Existing standalone copies are migrated deliberately. Do not leave a hidden standalone updater that can replace an npm-owned app.

## Release coordination

Revise [RELEASE_WORKFLOW.md](../RELEASE_WORKFLOW.md), the [desktop runbook](./desktop-release.md), and workflow code together. Once unified installation ships, required desktop artifacts cannot be bypassed by disabling the desktop release variable.

1. Resolve the immutable version tag and source SHA; verify coordinated manifest versions and changelog content.
2. Run the required cross-platform release matrix. Build signed/notarized arm64 and x64 apps from the same source; verify artifact identity and complete manifests/checksums. Validate the packed npm artifact carries the same release identity.
3. Stage the complete desktop assets privately. Validate all required artifacts before making any public.
4. Make the complete desktop release public and independently verify anonymous downloads through the exact installer URLs. Only then publish the corresponding npm version. For `latest`, advance discovery only after the intended release checks; explicit version installation must also have assets available.
5. Publish npm with existing OIDC protections, verify the registry version and `gitHead`, and complete the public installation smoke. Record exact artifact hashes and workflow attempt identities.

Public desktop assets are immutable. A retry after desktop publication reuses and verifies the exact public assets; it must not rebuild signed bytes and overwrite them. A retry after npm acceptance verifies the existing npm identity and completes missing verification without republishing. Missing, mismatched, or corrupt public artifacts require a new version. Private draft assets may still be replaced before publication under the existing immutable-source policy.

This moves the unavoidable partial-publication window to desktop-assets-available/npm-not-yet-available. Show an honest release status if npm publication fails and resume from that state. Do not restore the old npm-visible/desktop-private sequence. Separate draft mutation from public-release verification in `.github/workflows/publish.yml`; the current unconditional rejection of an existing public release is unsuitable for this retry flow.

Remove Squirrel ZIP/update-feed requirements if no remaining distribution or CI consumer needs them. Retain one verified installation container per architecture, manifests, and checksums. Do not remove artifact formats until their current consumers have migrated.

## Migration and removal

Inventory known managed receipts and exact app paths before migrating. Install the verified replacement at the stable path, validate its receipt and normal launch, and only then remove obsolete managed copies whose identity and lack of use are proven. Unknown, modified, or running copies are reported and left in place. Do not delete arbitrary apps named Quarterdeck or follow external symlinks. Preserve runtime state, browser/Electron profiles, drafts, projects, worktrees, and provider resume identities.

New launch guards cannot retrofit an old binary. Legacy copies that do not participate in installation admission still have a scan-versus-launch race. Include their removal in the native replacement feasibility gate; until safe OS-level exclusion is proven, require an explicit manual/offline migration step for those copies and keep automatic pruning disabled. Likewise, an old Dock target cannot be promised to enforce the new pairing contract before it has been migrated. Report these retained copies and the exact completion step rather than declaring migration complete.

Treat Dock migration as a one-time user-environment operation, separate from every npm install. Replace only the known Quarterdeck entry after confirming its old target; preserve position and unrelated entries. Test actual macOS alias behavior through replacement. If the supported implementation cannot safely update that entry, give the explicit remove-old/add-new instructions and verify the resulting target before pruning the referenced legacy copy. Do not rewrite the entire Dock configuration or kill the Dock during an ordinary install.

`quarterdeck desktop uninstall` uses the same ownership and in-use checks, removes only verified installer-owned app files and metadata, and reports any retained uncertain copy. Follow it with `npm uninstall -g quarterdeck` in the owning prefix. Repeating removal is safe. If npm is removed first, the app shows missing-owner guidance, and documentation explains manual removal of the app without deleting user data. Modern npm does not provide an uninstall hook, so npm removal alone cannot promise cleanup outside its package directory. See [npm lifecycle documentation](https://docs.npmjs.com/cli/v11/using-npm/scripts/#a-note-on-a-lack-of-npm-uninstall-scripts).

## Implementation sequence and acceptance

| Milestone | Deliverable and dependencies | Acceptance evidence |
| --- | --- | --- |
| 1. Contracts and replacement feasibility | Define mode precedence, receipt/provenance schemas, owning-prefix policy, and launch/replacement admission. Prove permanent-path behavior before replacing the current slot model. | Focused policy tests and a packaged synthetic launch-versus-replace experiment, including main crash with helper alive. Resolve the native early-admission question before proceeding. |
| 2. Shared installer transaction | Implement staging, bounded journal/backup, recovery, status, and removal on the agreed admission primitive. | Real-filesystem and cross-process fault-injection tests at every durable phase; no running app files replaced, no unrelated paths changed, repeated repair converges. |
| 3. Unified entry points | Add npm hook, default desktop selection, Dock preflight, and plain local link orchestration. Depends on installation contracts and transaction. | Executable CLI routing, isolated npm artifact installation, skipped-hook repair, same-version local rebuild, owner-conflict and partial-link tests. |
| 4. Update and release consolidation | Replace native update flow and notification policy; update provenance validators and publication order/retries. Can develop in parallel with milestone 2 after schemas settle. | Focused menu/update policy tests, release-manifest and retry-state tests, workflow syntax checks, no remaining production feed or auto-install caller. |
| 5. Migration and documentation | Add explicit legacy migration, Dock procedure, removal flow, help/man/setup docs, and diagnostics. | Synthetic old installations and profiles survive migration; only unused verified copies removed; native Dock target verified. |
| 6. Integrated acceptance and rollout | Reconcile the final tree, run affected integration gates, package exact candidates, complete signed and platform acceptance, then perform the user's migration when requested. | Passing evidence below, complete provenance, clean lab shutdown, and no outstanding release gate hidden by local stability. |

Assign disjoint implementation ownership to installer/launcher and release/updater work after contracts settle. Serialize shared contracts, dependency manifests, desktop main composition, and final integration. Use one combined correctness/maintainability review for routine edits and a distinct review of transaction/process races and publication retries. Do not execute this plan merely because it has been recorded.

## Verification matrix

Follow [testing.md](./testing.md). Reuse unchanged passing checks and run only the lanes needed for the changed claim.

| Area | Required cases |
| --- | --- |
| Mode selection | Bare graphical Mac, headless Mac, unsupported platform/OS, explicit modes, existing runtime flags, all maintenance/hook commands, and internal helper launch without recursion. |
| Identity | Release source/version mismatch; different legitimate architecture build IDs; same-version local rebuild; stale global prefix; missing npm owner; local-to-release ownership transfer; wrong architecture and Rosetta. |
| Filesystem transaction | Download failure, bad checksum/signature, destination conflict, external symlink, insufficient space, permission failure, interrupted copy/rename/receipt commit/cleanup, rollback failure, corrupt journal, and idempotent retry. |
| Concurrency | Two installers, CLI launch versus replacement, real Dock launch versus replacement, multiple state homes, app closed with helper alive, PID reuse, reboot evidence, and unavailable process inspection. |
| npm and linking | Packed global install with supported default policies; scripts disabled; hook failure with actual npm package/bin outcome; browser opt-out; local dependency install with no app effects; relink failure; package-native PTY behavior. |
| App and runtime | CLI and Dock select the same installed identity; hidden app still blocks replacement; normal Quit retains draft/session decisions; attached CLI runtime survives; incompatible runtime reports restart guidance without forced action. |
| Updates and release | npm-only menu for published installs; local build guidance; explicit offline check; no periodic updater; public-assets-first sequence; retries before/after each publication boundary; mismatched public artifact refusal. |
| Migration and removal | Known legacy copy, unknown app at destination, Dock alias, running legacy copy, repeated migration, uninstall before/after npm removal, and untouched project/profile/draft data. |

Extend the existing suites in `test/runtime/desktop-install/`, `test/runtime/desktop-launcher.test.ts`, `test/runtime/commands/desktop.test.ts`, `test/integration/cli-launch-modes.integration.test.ts`, `test/utilities/dependency-workflow.test.mjs`, desktop launch/menu tests, and `.github/scripts/desktop-release-artifacts.test.mjs`. Add cross-process filesystem tests where mocks cannot establish race safety. Update `scripts/package-artifact-smoke.mjs` to preserve its installed native PTY check and Electron-tooling exclusion while separately exercising supported Mac app installation. Unpublished PR builds cannot fetch their app from a public version tag: keep an explicitly named browser-only baseline and use a freshly packaged synthetic local artifact for the separate product-install lane. That fixture must not introduce a production download-host override.

Use the repo-owned functional-testing skill for narrow packaged Agent Lab scenarios with synthetic data. Extend `scripts/agent-lab/desktop-npm-launch.ts` for stable-path launch, pairing, and replacement behavior. Keep install tests isolated from the real Applications folder, Dock, npm prefix, and state home. Use visible native validation only for actual Dock or dialog claims. Always stop the run. A real provider is unnecessary unless changed launch behavior leaves a provider-specific risk, and then requires explicit authorization.

The current ledger still lists signed/notarized artifacts, clean-user Gatekeeper installation, native Intel execution, and the oldest supported macOS as outstanding gates. Replace the old signed Squirrel N-to-N+1 gate with signed npm-coordinated N-to-N+1 installation, including quit refusal, interruption/repair, offline launch, and preserved data. Run these on both supported architectures; do not mark old updater tests as evidence for the new flow. Update the declared OS floor if it cannot be supported and verified.

## Documentation and completion

Update README, DEVELOPMENT, command help and the man page, desktop architecture/release/validation docs, package-smoke guidance, and release workflow documentation as their corresponding behavior changes. Add a changelog entry when the user-visible implementation lands. Record the installer transaction, launch admission, and partial-update invariants in the implementation log because future maintenance needs that forensic context. Update instruction routing only if the new ownership boundary warrants it, and run the instruction-bridge check only when those files change.

Implementation is complete when the documented commands install and launch one app, both entry points reject incomplete pairing, replacement never forces shutdown, rollback and cleanup are bounded, npm is the only published update authority, old copies can be migrated safely, browser/platform behavior remains supported, and the affected tests and release gates pass. Public release readiness and local implementation completion must remain distinguishable while signing or hardware access is outstanding.
