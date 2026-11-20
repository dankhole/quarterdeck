# Desktop architecture and operation

Quarterdeck is a macOS and Windows desktop product. Its Electron shell packages the React renderer and local runtime; the CLI launches or manages the installed app. Standalone browser and Linux/headless product use are no longer supported. Internal headless runtimes, hidden Electron tests, and shared Linux source checks remain supported development infrastructure. Desktop distribution is a candidate until the [validation ledger](./desktop-validation.md) records the release gates. See the [release runbook](./desktop-release.md) for local builds and distribution.

Installation, launch identity, and update ownership are shared between the npm CLI and native app; Electron retains its own dependency tree and native ABI. This guide describes the current implementation. The [acceptance gates](./desktop-validation.md) distinguish implemented behavior from unperformed distribution and native-platform validation.

## Using the app

### Windows installation and operation

Windows desktop-capable npm releases support native x64 and ARM64 Windows 10/11. Install globally (`npm install --global quarterdeck`); a local `npm install quarterdeck` only adds a project dependency. The fixed per-user app lives at `%USERPROFILE%\AppData\Local\Programs\Quarterdeck`, with a Quarterdeck Start menu shortcut. No administrator installation is required. `quarterdeck` or `quarterdeck --desktop` validates the owning global npm package and requests the installed app. A missing or mismatched app requires repair; there is no browser fallback.

If npm blocks installation scripts, review the named packages with `npm install-scripts ls` and approve trusted Quarterdeck/node-pty scripts with `npm install-scripts approve quarterdeck node-pty`. A skipped Quarterdeck hook does not install an app. Run `quarterdeck desktop install` to complete or repair an available CLI's matching app, and `quarterdeck desktop status` to inspect the recorded pair. A source checkout uses `npm run link -- --desktop` to build and install an exact local pair. Standalone unpacked ZIPs deliberately refuse launch outside the managed path.

Windows uses the launch environment and semicolon-separated PATH, with bundled Node first. Add agent/Git executable folders in **Settings → Runtime Environment** when needed; login-shell import is a macOS option. Menus use Ctrl shortcuts. Closing the main Windows window enters guarded Quit, including draft and live-session checks; macOS retains its hide-on-close behavior.

The Start menu shortcut and taskbar relaunch command use `Quarterdeck.exe`. The internal `QuarterdeckHost.exe` rejects direct launch because it has no installation lock. Windows link tracking is disabled for the managed shortcut so it keeps the fixed launcher path. Repair also recognizes a shortcut retargeted to the adjacent host when its Quarterdeck app ID and empty arguments still match.

Updates remain npm-owned. The app prepares a private, authenticated handoff to an external Node/npm installation and opens PowerShell through Explorer. Only acknowledged authorization, final commit, normal app exit, and unchanged owner/tool identities permit the exact-version npm command. Explorer launches the worker outside the application's job, so it can replace the app after admission drains. Cancellation, unavailable Explorer/toolchain, failed npm, or failed pair verification retains explicit recovery guidance. There is no Electron self-updater or unattended update. `quarterdeck desktop uninstall` removes only the owned app and shortcut, preserving runtime state, settings, task work, and provider identities.

Installation stages and verifies a complete candidate before exclusive native admission, then journals backup, promotion, receipt, shortcut, and cleanup. Recovery recognizes exact trees and owners; a changed app or unrelated shortcut is retained. Release ZIPs are checksum-bound to the immutable npm source and reject links, traversal, Windows aliases/device names, duplicate paths, and excessive expansion. Public Windows builds are unsigned (`windows-unsigned`); npm and the fixed GitHub release repository provide distribution provenance, not Authenticode. SmartScreen and organization policy remain OS controls.

The OS-only bootstrap holds shared admission and a non-breakaway Windows job across Electron, bundled Node, Chromium, crashpad, and descendants. It never uses kill-on-job-close. A lost bootstrap leaves a flushed launch marker: installation/update/uninstall remains blocked until a different kernel boot identity proves prior processes cannot survive. **Restart Windows** when that recovery message appears; do not delete markers or use process age/PID guesses. Normal Quit drains descendants and removes its marker. Metadata uses owner/System DACLs; reparse-point ancestors and hard-linked locks are refused. File contents are flushed before atomic publication; Node cannot fsync Windows directories, so recovery also validates trees and receipts after interruption.

Native C++ Build Tools are required for source packaging, not end-user installation. `npm run build`, then `npm --prefix desktop run make`, creates the native package and ZIP. Packaging checks PE architecture, ASAR identity, resource hashes, security fuses, pinned Node, and actual ConPTY operation. Local candidates permit only the isolated lab inspector; public candidates disable it. See the [release runbook](./desktop-release.md) and [acceptance gates](./desktop-validation.md) for architecture/OS and public-distribution evidence.

### macOS installation

On macOS 13+ arm64/x64, an eligible `npm install -g quarterdeck` installs the matching app at `~/Applications/Quarterdeck.app`; plain `quarterdeck` requests its launch in a verified local graphical session. Finder and Dock launch the same app. npm remains required for installation and updates; this is not an independent Electron self-updating distribution. Source, nested dependency and CI installations do not acquire the user's desktop installation. Transient `npx` is not a standalone browser product.

### macOS security and first launch

Public desktop releases use an **ad-hoc signature**, not a paid Apple Developer ID or notarization. Signature integrity, immutable source matching, release checksums and production Electron fuses are verified, but an ad-hoc signature does not authenticate a developer to Apple or establish that an app is malware-free. npm and the fixed GitHub release repository are the distribution trust boundary.

If macOS blocks a trusted download as unidentified or unnotarized, try opening it once, then use **System Settings → Privacy & Security → Open Anyway** if macOS offers that action. See [Apple's guidance](https://support.apple.com/en-us/102445). Managed Macs may prohibit this exception. Do not bypass a harmful-app warning. The installer never strips quarantine, disables Gatekeeper, or adds an OS trust exception; it cannot guarantee that a quarantined app will open. Each replacement can require renewed approval.

Chromium cookie encryption remains enabled. **Quarterdeck Safe Storage** Keychain consent may recur across ad-hoc updates; stable Developer ID continuity is not promised. Do not reset the Keychain, broaden access permissions, or disable encryption as an installation workaround. The [optional signing lane](./desktop-release.md#provision-signing-once) remains available if trusted signing is adopted later.

### Desktop installation and migration

The npm manifest declares desktop release capabilities rather than a user-selectable mode. `adhoc-v1` requires matching production ad-hoc macOS ARM/Intel assets; `signed-v1` requires the optional signed/notarized lane. Windows requires matching `unsigned-v1` assets. Missing, browser-only, or unknown capabilities cannot publish a new desktop-only release. See the [release runbook](./desktop-release.md#coordinated-publication).

Installation and launch policy:

| Invocation or environment | Behavior |
| --- | --- |
| Supported global npm install/update by an ordinary user | Install the matching app through the lifecycle hook. |
| `quarterdeck` or `quarterdeck --desktop` on a supported local graphical host | Validate and request launch of the installed app; never download, repair, or silently fall back. |
| Source checkout, transient `npx`, nested dependency or CI install | Do not acquire the user's desktop installation; use the paired source workflow or isolated tests. |
| Unsupported platform or non-graphical product launch | Fail with desktop requirements; do not start a browser server. |
| Explicit internal runtime invocation | Development/test or desktop-helper infrastructure only; authentication and state ownership still apply. |

Before upgrading a browser installation, save unsaved files and drafts in the old browser profile and stop the old runtime. Remove `QUARTERDECK_INSTALL_MODE=browser` from shell configuration and install commands, then run `npm install -g quarterdeck@latest`. Old `.quarterdeck-install-mode.json` files are left untouched but ignored; they no longer opt out of desktop. A legacy `QUARTERDECK_INSTALL_MODE=browser` value warns and is ignored rather than selecting an alternative mode. Projects, tasks, settings and provider resume identities remain in the canonical state home; do not remove that directory. Browser-profile-only unsaved data is not automatically transferred into Electron. Close old Quarterdeck tabs after saving; if a cached offline page keeps refreshing, clear that site's data to unregister the retired service worker. Linux and standalone headless users must move to a supported graphical host to use the product.

If lifecycle scripts are disabled, the hook cannot install the app. `quarterdeck desktop status` is read-only; `quarterdeck desktop install` explicitly installs or repairs the pair. A missing/mismatched app blocks launch until repaired.

`npm run link` builds one local runtime/UI/app pair, links this checkout, and passes the app to the same installer. Published artifacts pair by version and immutable source SHA; local artifacts must also share the exact build ID. One per-user app belongs to one global npm package slot and its resolved package directory. Switching checkout or npm prefix requires explicit ownership replacement. Launch only validates and opens an installed pair; it never downloads or repairs it silently.

For an installed local pair, standalone builds and cleanup refuse to change the owning checkout's build output. Use `npm run link -- --desktop` to update that checkout and the app together, or use another worktree for build-only validation. The paired workflow verifies the new CLI/app identity and absence of pending installation work before reporting success. A failed paired build or installation still requires repair; the guard does not make rebuilding and app replacement atomic.

Installer metadata lives in the private `~/Library/Application Support/Quarterdeck/installation` directory, outside the app bundle and canonical runtime state. The app location is fixed rather than a configurable per-project path. The installer stages and verifies a replacement before requesting exclusive installation admission. A running app or bundle-dependent helper blocks replacement with quit-and-retry guidance; no sessions are killed. The transaction journal and temporary backup support interrupted replacement recovery. A successful replacement removes its temporary backup. Old managed UUID copies are not a permanent version store, but unguarded legacy copies require explicit safe migration rather than speculative deletion. The fixed app location keeps new Dock shortcuts stable; replace a shortcut to an obsolete managed copy once after quitting that copy.

npm and the app cannot change atomically. Both CLI and Dock startup validate the owner, receipt, build identity, and transaction state before starting runtime work. A missing npm package, changed owner, interrupted transaction, or mismatched pair produces repair guidance. It does not start a browser runtime. `quarterdeck desktop uninstall` removes the owned app safely before `npm uninstall -g quarterdeck`; npm does not provide a reliable uninstall lifecycle hook. Neither command removes projects, sessions, or runtime state.

The launcher passes the canonical state home and current repository through a bounded native request. First and subsequent launches use authoritative project registration and SPA navigation, with unsaved-work guards. It does not reload the renderer to change projects or start a second CLI runtime. A protocol-aware running app rejects a request for a different installation and asks you to quit and retry. Quit a pre-launcher standalone candidate once before switching: those older apps cannot understand this request and may only focus their window. The CLI reports “launch requested”; it does not claim the app has finished starting.

Open Quarterdeck from Finder or the Dock, then choose **File → Add Project…** (`Cmd+O`) for a repository. Quarterdeck includes its own Node runtime; Git and the agent CLI you choose must already be installed and signed in. If an installed command is missing, open **Settings → Runtime Environment**, add its executable folder if needed, and refresh the runtime. An app attached to a CLI runtime uses that CLI's environment; restart the owning CLI to change it.

| Action | What happens |
| --- | --- |
| Close the window or press `Cmd+W` | Hide the window while tasks continue. Click the Dock icon to return. |
| Quit with `Cmd+Q` | Review unsaved work and any live sessions before shutdown. A separately started CLI runtime stays running. |
| Git → Compare → Pop out Compare, or Uncommitted → Pop out Uncommitted review | Open a read-only, one-file-at-a-time review window with previous/next file and difference controls. The main window can show agent chat; closing review does not stop agents. Comment drafts remain in the main window. |
| View → Reload Window | Reload the interface after checking unsaved work; the runtime stays alive. |
| File → Restart Runtime… | Recover from a runtime failure after resolving unsaved work. This action appears enabled when recovery is available. |
| Help → Export Diagnostics… | Choose a folder for a diagnostic bundle, including app evidence when the runtime is unavailable. |

If a window crash leaves recoverable file drafts, review **Recover unsaved files** and restore the matching draft in Files. Restoring does not save the original file; use **Save file** explicitly. Recovery protects the last acknowledged snapshot, so keep a separate copy of important unsaved work if recovery reports a storage problem. A file can save successfully while updating its recovery copy fails; the warning distinguishes those outcomes. Retry recovery to restore protection; export a separate copy while storage is unavailable.

An npm-owned app checks the public npm registry once after startup and on **Check for Updates**. Stable installs follow `latest`; prerelease installs follow `preview`. A newer version appears in the native menu and an **Update available · vX.Y.Z** button beside Settings. Startup failures stay quiet. An explicit check reports errors or that the installed version is current. Local linked builds show their checkout's `npm run link` guidance and skip public checks.

Update details show the installed and available versions, the owning prefix, and release notes. **Update Quarterdeck** prepares a visible Terminal handoff, then uses the normal draft/session quit safeguards. Installation proceeds only after clean shutdown and app exit. The one-shot runner uses external Node/npm, installs the exact checked version in the recorded prefix, and verifies the resulting CLI/app pair. It reports progress, failures, and retry guidance in Terminal; reopen the app after success. There is no Electron self-updater, recurring check, unattended installation, forced session termination, or automatic relaunch. See the [update and recovery contract](./desktop-release.md#npm-update-and-recovery-contract) for ownership and failure boundaries.

## Shared settings and preferences

Desktop windows using the same canonical state home share global settings, project settings, project organization, boards, and session history. Persistent UI preferences also belong to that runtime: onboarding and tips, saved panel sizes, editor wrap/preview, Git comparison options, preferred application, and remembered task/prompt choices are stored in `ui-preferences.json`. Settings changes notify connected clients; reconnecting or returning to a window refreshes its settings.

On the first upgraded visit, valid preferences already present in the desktop profile seed only missing shared values. Existing runtime-owned shared values and explicit resets win. Browser-profile-only values are not automatically imported into Electron; save or synchronize desired preferences through the old version before upgrading, then adjust remaining choices normally. A fresh profile does not publish defaults during startup. Preference loading and save failures are visible rather than silently replacing shared values.

Window geometry, current navigation and selected files/tasks, unsaved drafts, browser permissions, authentication, and diagnostic records stay with their owning window or profile. Project-group collapse choices seed later visits without changing another open window's navigation. Native executable-folder overrides remain desktop launch configuration; an attached app uses the owning CLI's process environment. Sharing settings does not make independently launched processes inherit identical shell environments.

### Notification sounds

Desktop task notifications play Quarterdeck's short permission, review, and failure tones. The desktop main process owns playback, so hiding or reloading the window does not disable sounds. Playback honors the shared sound enablement, volume, event toggles, and current-project/focus suppression settings. Native notification banners are silent; their macOS permission does not control Quarterdeck's tones. System output volume and mute still apply.

Desktop cancels pending playback when presentation ownership is lost, the connection closes, the runtime changes, or the app quits. Settings sound previews remain explicit UI playback and do not depend on a new task event.

If previews work but task tones remain silent, check the event and focus suppression settings first. Playback failures appear as `notification_audio` events with a `failed` outcome in the desktop diagnostics journal; they contain the tone category, not task content or filesystem paths. Synthetic desktop tests record playback intent without using speakers or displaying native banners.

## Process and storage ownership

Electron main owns the window, native presentation, update guidance, and private IPC to a separate real Node helper. The helper owns PTYs, provider hooks, and existing runtime services. Its dependencies are built for bundled Node, separately from Electron's ABI. Runtime code, paired web assets, Node, and native modules live outside ASAR.

On Windows, the admitted desktop starts the verified Node host directly without a console. The helper inherits the installation lock and stays in the native app job, with private IPC governing runtime shutdown. The bundled Node wrapper remains the PATH entrypoint for terminal commands. Launching the desktop helper through that wrapper can create a separate console whose close event shuts down the runtime.

Installed app identity checks use the physical filesystem for both file metadata and content hashes. Electron's ordinary filesystem presents `app.asar` as a virtual directory, so using it for a regular-file check rejects valid packages even when CLI verification succeeds. Keep these checks on the shared physical filesystem boundary; do not toggle process-wide ASAR behavior or accept directories and symbolic links as required resource files.

Windows packaging omits the Claude Agent SDK's optional fallback executable. Quarterdeck resolves the installed Claude executable before using the SDK and supplies that path explicitly. Keeping the unused executable out of the bundle saves hundreds of megabytes of startup verification reads.

CLI and desktop enter through `startAdmittedRuntime` and `runtime-bootstrap`. Admission precedes cleanup, recovery, project registration, backups, and writable runtime construction. One runtime owns each canonical `QUARTERDECK_STATE_HOME` (default `~/.quarterdeck`). Claims record stable machine identity, PID and process birth, generation, and process custody protocol. Immutable hard-linked successors elect a replacement only after proven death or explicit release. Sleep, stale timestamps, and unavailable process inspection never authorize takeover. State homes require a local filesystem supporting hard links.

Windows machine identity reads the exact registry `MachineGuid` through .NET's `Registry.GetValue` in the fixed system PowerShell executable. Keep this probe free of cmdlets: module discovery can exceed its five-second deadline in an isolated environment without the host's warmed module cache. Strict UUID validation and hashing remain mandatory; inheriting host module paths or lengthening the deadline is unnecessary.

Boot and process-birth probes require built-in cmdlets, so they explicitly import the Utility and, for process snapshots, CimCmdlets manifests from absolute paths under `$PSHOME\Modules`. Setting only a system module search path still permits slow discovery in a fresh isolated home. Keep these imports, existing query deadlines, and host/user module-path isolation together.

A second CLI or desktop helper authenticates the existing owner and checks its protocol/capabilities. Attachment does not transfer shutdown authority. Quitting an attached app revokes its credential and leaves the CLI runtime running. Stop or upgrade incompatible or unverifiable live owners. Older binaries cannot be forced to honor new admission; stop them before mixing versions.

Owned desktop helpers bind an ephemeral loopback port and publish the actual endpoint after listening. An attached helper uses its verified owner's endpoint; desktop attachment requires the owner to be bound to `127.0.0.1`. Explicit internal development/test runtimes may select a port, but CLI flag/environment binding accepts only literal `127.0.0.1`; ordinary CLI launch always selects desktop. Stop an incompatible older owner before restarting on loopback. This does not add remote desktop attachment. Independent lab and source-development runtime fixtures use separate state homes.

## Renderer admission

The window uses stable `app://quarterdeck` storage scoped to its canonical state home. Main proxies approved assets, runtime/project APIs, and browser diagnostic routes. Management and provider hook routes are excluded. Main injects a credential only for the selected generation and approved contents. Runtime state, terminal I/O, and terminal control sockets share one environment adapter.

Compare-only windows use separately admitted sandboxed renderer documents and the same runtime generation. Uncommitted review uses an additive preload capability; if an attached shell predates it, update/restart the desktop app rather than substituting a branch comparison. Legacy Compare links retain their original meaning. They receive runtime transport access, not the main window's native command, notification, or quit-preflight authority. Runtime replacement closes these auxiliary windows; reopening captures a fresh comparison target. They never mount editable-file recovery or attach a terminal.

The renderer has context isolation, sandboxing, and no Node integration. Its versioned preload exposes typed commands and responses. Sender, frame, generation, schema, endpoint, and navigation checks are mandatory. Never expose arbitrary executable arguments, raw IPC, or general filesystem access. Existing domain owners remain the only board/session writers.

Only admitted desktop renderers receive product access. Browser bootstrap URLs, cookie sessions and standalone HTML entrypoints have been removed. Management, provider hook and diagnostic credentials retain their separate scopes. Internal test/development execution does not relax desktop renderer authentication.

## Shutdown and recovery

Window close hides the app and retains task/editor state. Quit and runtime restart share draft protection, live-process decisions, producer drain, process shutdown, persistence, and server close. Idle and input-waiting processes count as live. Attached clients never stop the independent owner.

Desktop file recovery stores a bounded snapshot in the renderer's state-home partition using an explicitly strict IndexedDB transaction. Only transaction completion acknowledges a revision. A single writer retains edits arriving during a commit, and Save waits for the revision that removes the saved draft before reporting ordinary success. Loading, uncommitted revisions, and storage errors block the final Quit, reload, runtime-restart, or restart seal. A persistent storage failure can therefore keep these actions blocked until recovery succeeds; exporting protects the text but does not itself repair storage.

Recovery copies remain local to the persistent Electron profile and never enter diagnostics. They contain file text and original revision metadata and are not encrypted independently of the user's disk/profile protections. Limits are 32 drafts, 512 KiB per serialized draft and 2 MiB total, counting conservative UTF-16 bytes including original text and metadata. Previously recovered copies expire after 30 days; current unsaved text is never truncated or evicted to meet a quota.

Restoration checks project, task creation time, repository/worktree and file identity, and refuses a newer unsaved tab. Restored text bypasses autosave until explicit Save and retains the original content-hash conflict check. Export and discard remain available without saving the original file. Task/settings prompt contents are outside this recovery mechanism. An unreadable or invalid snapshot pauses new recovery writes; confirmed **Reset saved recovery** discards it only after current drafts fit and the replacement transaction commits.

An existing IndexedDB record, including an empty snapshot, is authoritative. When no record exists, valid legacy local-storage drafts are imported once and removed only after the new snapshot commits. Unreadable or invalid storage is preserved for explicit reset. The importer cannot identify a draft that an older build had already saved but failed to remove durably, so such a draft may require one review. This contract covers the last acknowledged recovery snapshot, not every keystroke or all hardware and power-loss failures.

Shutdown returns a bounded response and a separate completion promise. It fences ingress, drains admitted producers, permanently fences new process launches, and only then snapshots and stops owned processes. One process-tree owner confirms descendants stopped before signalling their parents; marking sessions Interrupted must not kill PTYs ahead of that owner. Final persistence retains the write lease until quiescence. Its authoritative-session projection reads an existing owned store without re-entering manager registration: registration and new producer barriers are already fenced while the admitted final write drains. Even incomplete completion must first unsubscribe/fence automatic writers and drain admitted state writes, independently of process-owner disposal. Retrying process cleanup does not reopen finalized persistence or erase a persistence failure. Deadlines, persistence failures, and unconfirmed processes do not authorize ownership release or app replacement. Write and launch fences remain installed after release to reject late work. Lease loss fences subsequent work and closes without ordinary persistence. Parent-channel loss waits for completion; an incomplete final result exits unsuccessfully with the claim unreleased.

A later Quit retries settled incomplete cleanup using the original captured process identities and any unresolved coverage gaps. Concurrent requests share the in-flight attempt; a timeout does not start overlapping cleanup, and successful cleanup stays idempotent. Never replace retained targets with a fresh tree rooted only at still-live parents: that could lose orphaned children and falsely report clean shutdown.

Normal Quit may offer an explicitly confirmed **Force Quit** after the helper acknowledges completion, even if process cleanup remains unconfirmed. A bounded timeout alone cannot enable this escape. Draft recovery and the final frontend seal still apply. This exits without claiming clean process cleanup or releasing an unclean ownership claim; remaining commands may need to be stopped and session recovery confirmed on the next launch. Restart and update never use this escape.

Immediately before a covered spawn, the owner synchronously publishes and syncs a custody marker. This covers PTYs, structured providers, title agents, setup scripts, Git, language servers, and executable availability probes. Fixed OS identity/ACL probes and intentionally independent native-open effects are excluded. Isolated factories have no production guard until explicitly installed.

Recovery inspects previous claims and saved process evidence before workspace mutation. Clean release or a supported generation that never launched covered processes can proceed. An unclean dirty generation blocks automatic recovery even when its original root PID disappeared. A verified different boot proves prior processes cannot remain. A blocked upgraded launch provides an observation anchor so legacy custody can be resolved after reboot. Corrupt evidence remains intact. Backup creation and restore use the same maintenance admission and recovery checks because copying state can replay committed transactions.

The startup error offers **Recover sessions…** as an alternative to rebooting. The confirmation asks the user to check and stop any remaining agents or detached background commands. The app then runs the bundled recovery command and retries ordinary startup. Cancelling leaves recovery blocked. Recovery refuses a live runtime, live saved process evidence, unreadable evidence, or an unavailable boot identity; it never signals a process using only a saved PID.

The CLI equivalent is `quarterdeck recover` to inspect, followed by `quarterdeck recover --confirm-stopped` after checking remaining commands. Both use exclusive maintenance ownership. Confirmation publishes a private, immutable acknowledgement bound to the exact maintenance claim, its validated predecessor history, host, state home, and current boot. It preserves the original claims, custody markers, board state, task work, and provider session identities. The acknowledgement records the user's decision about untracked descendants; it does not claim verified cleanup or fabricate a clean shutdown. A later unclean generation requires a new confirmation. Reboot remains an alternative when the user cannot account for remaining commands.

Confirmed shutdown covers tracked process trees/groups and validated provider behavior. Parent-PID links must also have compatible process birth ordering before admitting roots or descendants, including children discovered during cleanup. Windows can retain a stale parent PID after that PID is reused; rechecking the selected child's identity does not establish that it belongs to the newer parent. Missing or ambiguous ancestry evidence must not authorize a signal or clean release. Arbitrary user commands can daemonize outside those trees; this is not an OS containment sandbox. Never infer complete cleanup from an absent root PID or broaden a kill by executable name.

On macOS, a captured process whose parent changes is observed without further PID-based signals because BSD birth timestamps have coarse precision. If it subsequently disappears during cleanup or a later retry, that captured target is confirmed stopped. A still-live target, an incomplete initial ownership snapshot, or newly observed descendants under an unverifiable parent continue to block clean release.

## Native boundaries

`IRuntimeHostIntegrations` remains the runtime boundary for project, path, URL, IDE, and folder-picker effects. App-owned helpers forward allowed effects over private IPC; attached CLI runtimes keep their host implementation. Native commands use shared UI handlers. Quit/reload protection includes unsaved settings, task drafts, and cached file drafts. Recovery exports use explicit save dialogs rather than unrestricted downloads.

The app resolves its launch environment once, importing exported variables and executable paths from an interactive login shell by default, including Finder/Dock launches and setup in files such as `.zshrc`. Shell aliases and functions are not imported. **Settings → Runtime Environment** lets users add executable folders or disable login-shell import; explicitly saved opt-outs remain disabled. With import disabled, it supplements the inherited PATH with common executable folders and one selected nvm installation. Changing either setting requires the normal guarded environment refresh or the next app launch. Only bounded folder preferences and the import choice are persisted; environment values are never saved. Attached CLI runtimes retain their owner's environment and require restarting that CLI. See [desktop environment resolution](./desktop-environment.md) for precedence, supported layouts, and validation boundaries. Git and agent CLIs remain user-installed; the app does not change provider sign-ins or shell files. Quarterdeck itself uses bundled Node.

Published installation requires an explicitly declared ad-hoc or signed release policy, valid bundle signature integrity, production release fuses, checksums and npm-owned update authority. Ad-hoc releases must be marked as public ad-hoc builds and cannot masquerade as signed/notarized releases; a signed-capable npm package still requires Developer ID/team, hardened runtime, entitlements and Gatekeeper verification. Local inspection-enabled candidates use the explicit local import path and cannot be promoted as public release artifacts. The update menu never changes desktop bytes independently of npm. See the release runbook for publication and replacement evidence.

The packaged resource list that gets checksummed and verified — `runtime/dist/cli.js`, the lightweight `runtime/dist/hooks.js` hook entry, bundled Node, `app.asar`, and the rest — is a single shared list (`desktop/scripts/desktop-resource-paths.mjs`), consumed by packaging (`artifact-manifest.mjs`), artifact verification (`verify-artifact.mjs`), and the npm-installed CLI's own paired-install check (`src/desktop-install/metadata.ts`). Add a new packaged resource there once rather than updating each consumer's own list.

## Maintaining desktop

Implement domain behavior in the shared UI and runtime. Board state, task lifecycle, provider compatibility, Git, Files, and settings keep their existing owners. Put native presentation and application lifetime in `desktop/` and expose only typed capabilities through the existing bridge. The renderer requires desktop bootstrap; missing native capabilities fail explicitly rather than switching to a standalone browser implementation.

Select checks by the changed boundary. Ordinary features use focused runtime/UI tests; transport, attachment, persistence, and lifecycle changes also need the affected desktop paths. Native shell or dependency changes need a fresh packaged candidate. The npm runtime package and Electron retain separate dependency trees and native ABIs. Shared Linux tests and internal headless runtimes are engineering tools, not an additional product mode. See [testing scope](./testing.md).

## Source map

| Boundary | Implementation |
| --- | --- |
| npm/CLI installation, receipt and transaction | `src/desktop-install/`, `src/commands/desktop.ts`, `src/launch-policy.ts`, `src/desktop-launcher.ts` |
| Local dependency/build/link orchestration | `scripts/dependency-workflow.mjs`, `scripts/desktop-local.mjs` |
| Native installation admission | `desktop/native/`, `src/desktop-install/admission.ts`, `desktop/src/installation-preflight.ts` |
| Shell composition and runtime selection | `desktop/src/main.ts`, `runtime-supervisor.ts`, `runtime-selection.ts`, `launch-config.ts` |
| Renderer admission and shared UI transport | `desktop/src/protocol-proxy.ts`, `renderer-admission.ts`, `preload*.ts`, `src/shared/desktop-*-contract.ts` |
| Environment setup | See the [environment owner map](./desktop-environment.md#ownership-and-validation). |
| Registry checks and explicit npm handoff | `src/desktop-update/`, `desktop/src/update-controller.ts`, `npm-update-runner.ts`, `npm-update-worker.ts` |
| Packaging and release identity | `desktop/forge.config.mjs`, `desktop/scripts/`, `.github/workflows/desktop-*.yml`, `.github/scripts/desktop-release-artifacts.mjs` |

## Dependency maintenance

The desktop maintainer owns Electron, bundled Node, Forge, signing/notarization tools, and native-module compatibility together. Review upstream releases and security advisories at least monthly and handle relevant security fixes promptly instead of waiting for feature releases. Keep exact versions and archive checksums in the desktop manifests; update its separate lockfile without importing Electron into the npm runtime dependencies.

The ASAR-scoped `glob` and `minimatch` overrides in `desktop/package.json` bridge upstream ranges that exclude the security-fixed majors (GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249). ASAR uses the retained async `glob()` and `minimatch()` APIs. Keep these overrides scoped to ASAR; remove them only when upstream accepts patched versions and both the desktop audit and fresh packaging checks pass. Do not use `npm audit fix --force` to downgrade Forge as a substitute.

For an upgrade, read upstream migration and security notes, rebuild each supported native architecture, verify helper Node/native ABI and paired runtime/renderer identity, and repeat the affected protocol, clipboard, launch, shutdown, and packaged-provider checks. Changes to Electron, signing tools, entitlements, fuses, or update behavior also require the applicable ad-hoc or signed-install and npm replacement evidence before promotion. Record the candidate and any unsupported host combinations in the validation ledger. Do not relax fuses or provider compatibility gates to make an upgrade pass.

## Isolated validation

Use the repo-owned functional-testing skill and `npm run agent:desktop` against an actual packaged app. The harness creates synthetic state, projects, storage, and tracked processes. Its lab-only `--use-mock-keychain` switch keeps Chromium cookie tests away from the user's macOS keychain; ordinary launches retain native encryption. Never modify or reset a user's keychain to make a test pass.

Routine desktop tests keep their window hidden and unfocused. `--show-window` explicitly enables checks that need visible native activation; it may take focus. A hidden run cannot prove window placement, close/activate, or notification presentation.

Record exact artifact/build identity and cleanup results. Source tests do not validate stale packages. Native ARM/Intel execution, oldest macOS, quarantined installation, npm replacements, and elapsed daily use are separate ledger gates. Signed/notarized identity and prompt-free continuity are additional gates only for the optional signed lane.
