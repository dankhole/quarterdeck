# Desktop release runbook

The default desktop distribution is a **public ad-hoc-signed macOS app installed and updated by npm**, without Apple Developer membership or notarization. The [npm release workflow](../RELEASE_WORKFLOW.md) publishes and anonymously verifies both native architectures before publishing the matching npm package. Every release also requires unsigned Windows x64 and ARM64 assets. Standalone browser releases are removed; an optional paid macOS Developer ID signing lane remains supported. Workflow implementation is not proof that the [native-platform acceptance gates](./desktop-validation.md) passed.

The current `package.json` declares `quarterdeck.desktopRelease: "adhoc-v1"`, enabling desktop defaults on eligible Macs. No Apple credentials or GitHub signing environment are required for this mode. Keep the optional signed-lane variable `QUARTERDECK_DESKTOP_RELEASES` unset unless deliberately enabling that lane; it does not control ad-hoc publication. This worktree prepares a new release and does not change already-published npm versions.

## Windows builds and coordinated publication

`quarterdeck.windowsDesktopRelease: "unsigned-v1"` declares Windows desktop defaults. The publication workflow requires both native Windows x64 and ARM64 ZIPs and manifests from the exact reviewed source, alongside the declared macOS assets, before npm publication. `.github/workflows/desktop-windows-release.yml` builds them on native Windows runners without signing credentials. A public retry anonymously downloads and verifies the complete immutable asset set and shared `SHA256SUMS`; missing Windows assets cannot be added to an already-public release by overwriting it. Prepare a new version under the [npm release workflow](../RELEASE_WORKFLOW.md).

On a native Windows source checkout with C++ Build Tools, run `npm run build`, then `npm --prefix desktop run make -- --arch=x64` (or native ARM64). Set `$env:QUARTERDECK_DESKTOP_DISTRIBUTION='windows-unsigned'` only for a clean public candidate. Local candidates keep inspector-enabled fuses for `npm run agent:desktop -- smoke --app <absolute-package-directory> --json`; public candidates disable inspection. The Windows lab compiles a fixed synthetic profile into its private bootstrap, then imports through the actual installer, checks native Chromium/crashpad job membership, and verifies replacement and uninstall after confirmed process cleanup. It never redirects production installation through an environment variable.

Windows builds use the system `tar.exe` for ZIP creation because Windows PowerShell's ZIP API rejects long dependency paths under deep checkouts. Rebuild before packaging if the checkout's Git revision or clean/dirty status changed after the root build. The runtime and bundle must carry the same provenance for the installer to admit the pair.

Windows updates use an external, verified Node/npm toolchain and a private named-pipe handshake. Explorer opens the visible PowerShell worker outside the application's non-breakaway job. The worker receives environment values only after token authentication; its launch script clears inherited injection variables before Node starts. It requires authorization, final commit, parent exit, unchanged tool/owner identities, exact-version npm success, and ready-pair verification. Cancellation and failed verification never imply a successful update. Unsigned Windows assets can be subject to SmartScreen or organization policy; the installer does not create an OS trust exception.


## Release capability and desktop-only migration

The immutable tag's `quarterdeck.desktopRelease` must explicitly select `adhoc-v1` or `signed-v1`, binding npm defaults to the expected public macOS policy. `adhoc-v1` requires public `ad-hoc` ARM/Intel artifacts, production fuses and an embedded `distributionMode: "ad-hoc"`. `signed-v1` requires the protected signed lane, enabled with repository `QUARTERDECK_DESKTOP_RELEASES=1`, and `signed-notarized` artifacts; it never accepts an ad-hoc downgrade. `quarterdeck.windowsDesktopRelease` must explicitly be `unsigned-v1`, requiring both Windows architectures. Missing, legacy, unknown and `browser-only` capabilities cannot publish. Local inspector-enabled prototypes are never public releases.

A fresh eligible global npm installation installs the matching desktop app. Eligibility still requires an ordinary non-root user, supported native host and permitted lifecycle scripts, outside source/CI/transient npm use. Ordinary CLI invocation validates and launches the installed pair only in a verified local graphical session; it never downloads, repairs or falls back to a standalone runtime. Internal headless execution remains available to explicit development, diagnostics and synthetic tests, not as a public launch mode. See [desktop architecture](./desktop.md) for installation and launch policy.

**Required desktop-only upgrade guidance:** prior browser users must install desktop on supported macOS or Windows with `npm install --global quarterdeck@X.Y.Z`, substituting the target version and permitting lifecycle scripts. Saved prefix browser preferences no longer opt out; remove `QUARTERDECK_INSTALL_MODE=browser` from installation commands and shell configuration. `--browser` is removed. With hooks disabled, repair using `quarterdeck desktop install` when permitted before launching; script-disabled npm success does not prove a ready app pair. Linux and SSH/headless standalone product access end. Save browser-profile-only unsaved files and drafts before upgrading; they are not automatically transferred into Electron. Preserve the canonical state home containing projects, tasks, settings and provider resume identities; no state deletion or data migration is required. npm owns installation and updates; there is no independent Electron updater.

## Public ad-hoc artifacts

An `adhoc-v1` release builds on native ARM and Intel macOS runners from the resolved immutable source. The public build sets `QUARTERDECK_DESKTOP_DISTRIBUTION=ad-hoc`; it does not import an Apple keychain, request a signing environment, or run notarization. Packaging applies a valid ad-hoc signature after all bundle changes, verifies signature integrity and native helper execution, disables CLI inspection alongside the other production fuses, and records the public mode in the bundle and release manifest. The inspector-enabled local artifacts below are deliberately ineligible for public promotion. The same ad-hoc packaging command can verify production settings in a dirty worktree, retaining `sourceDirty: true`; finalization and public release validation reject that candidate. Never rewrite provenance to make it publishable.

The native admission executable and its Electron Host are siblings inside each app bundle. Sign each Host before sealing its containing app; signing the admission executable first can prematurely seal a bundle whose Intel Host is still unsigned. The packager defers only known admission executable paths to the normal app-signing step, which signs and seals them too. Signing errors must stop packaging, and strict nested signature verification must remain enabled in both public distribution modes.

Users may need **Privacy & Security → Open Anyway** if macOS blocks the app, and may encounter renewed Keychain consent after updates. Managed-device policy may prohibit launch. Follow [first-launch guidance](./desktop.md#macos-security-and-first-launch); never strip quarantine, disable Gatekeeper, or weaken encryption. Neither npm installation nor checksum verification is Apple notarization.

Downloads of `.dmg` and `.zip` are also available as release containers, but the supported ownership/update flow is npm: dragging out an app alone does not establish its matching npm owner and receipt. Do not advertise these containers as an npm-independent installer. If OS policy blocks the app, report that limitation; there is no browser fallback.

## Local unsigned candidate

For everyday source-checkout use, run this from the repository root:

```sh
npm run link
quarterdeck --desktop
```

`npm run link` installs missing or outdated root, web UI, and desktop dependencies from their lockfiles, builds one paired runtime/UI/app, links this checkout, and imports it through the shared installer. Quit the current app before replacement; download/build and verification happen first. The stable app location is `~/Applications/Quarterdeck.app`. This command intentionally adopts the selected checkout as owner. Use `npm run desktop:build` to build without installation; browser-only linking is removed. `--desktop` remains a compatibility alias for the default link behavior.

Build-only commands must run in a checkout that does not own the installed app. The owning checkout's standalone build and clean commands refuse before changing its output; use `npm run link -- --desktop` there instead. For the manual packaging commands below, use a separate worktree with its own dependencies. Paired linking verifies the exact installed build and requires no pending installation work before reporting completion.

The npm lifecycle installer downloads only a matching public release from the fixed repository/tag, verifies its expected distribution policy, source identity and DMG size/checksum, mounts read-only, validates bundle identity and signature integrity, and imports without running bundled code during verification. Public ad-hoc builds require valid ad-hoc signature integrity, not Developer ID or successful Gatekeeper assessment. The signed lane additionally verifies Developer ID/team, entitlements and Gatekeeper policy. `--from` is an explicit local-candidate import and is not evidence of signing or notarization. It requires the current desktop launch protocol marker; old candidates must be rebuilt. No installer removes quarantine or changes the user's Keychain.

Use a native Apple Silicon or Intel Mac for its corresponding architecture. Cross-builds are rejected because the bundled Node helper and `node-pty` must be validated against that architecture's real Node ABI. Install each dependency tree separately:

```sh
npm ci
npm ci --prefix web-ui
npm ci --prefix desktop
npm --prefix desktop exec -- install-electron
npm run build
npm --prefix desktop run make -- --arch=arm64
npm --prefix desktop run verify -- --manifest "$PWD/desktop/out/artifact-manifest-darwin-arm64.json"
```

Substitute `x64` on Intel. Run these commands from the repository root; verification uses an absolute path because npm runs desktop scripts from `desktop/`. The root build stamps runtime/renderer assets together; desktop commands consume those assets. The packaged helper contains pinned Node, production dependencies installed from the root lock, and Node-ABI native PTYs outside ASAR. Electron's dependencies and native ABI remain separate. Desktop tools do not enter the published npm runtime package.

These local artifacts use an ad-hoc signature, allow explicitly requested CLI inspection for the isolated test harness, and use source-checkout update guidance. They remain local candidates (`distributionMode: "local"`): they have no Developer ID identity or notarization and cannot be promoted directly as public ad-hoc releases. Packaging seals the completed app after metadata and fuse changes, and artifact verification checks signature integrity for local candidates as well as signed releases. An invalid signature can prevent macOS from requesting access to protected folders such as Desktop, leaving Git projects unavailable even when the same folders work in other applications. Rebuild and import an affected candidate; do not initialize or relocate an existing repository to work around that failure. Normal startup does not open an inspector listener; a passing local candidate is not signed-release or sustained daily-use acceptance.

The DMG maker uses macOS `ditto` and `hdiutil` to preserve the packaged app in a compressed HFS+ volume with an Applications link. It uses a plain Finder view; no image parser or third-party DMG layout tooling is required. DMG Developer ID signing and notarization are additional gates only for the optional signed lane.

`desktop-ci.yml` uses explicit `macos-15` ARM and `macos-15-intel` runner labels, pinned Node/npm build tools, independent lockfiles, unsigned DMG/ZIP artifacts, and isolated fake-provider Electron smoke. It uploads synthetic lab evidence on success or failure. Its ordinary download is a local prototype, not a public release installer. The corresponding [GitHub runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) identifies each label's architecture. It does not establish support on the macOS 13 minimum or prove signed Gatekeeper behavior.

## Provision signing once

**Optional paid lane only.** Skip this entire section for `adhoc-v1`; Apple enrollment and credential provisioning are not prerequisites for npm desktop distribution. These controls remain available if the maintainer later chooses Developer ID signing/notarization.

Keep signed publication disabled while completing this setup. An authorized maintainer must provision the Apple account and GitHub environment; repository code cannot create a trusted signing identity. Do not paste certificates, private keys, P12 passwords, API keys, or their base64 encodings into chat, issues, workflow inputs, or logs. Base64 is transport encoding, not encryption.

### Apple account and signing material

1. [Enroll in the Apple Developer Program](https://developer.apple.com/programs/enroll/) as an individual for personal distribution, or as an organization if a legal entity owns the distribution identity. Complete identity verification, current agreements, and payment; wait for active membership and confirm the intended team before creating signing material. The **Account Holder** creates an exportable **Developer ID Application** certificate using a certificate signing request from the custodian's Mac. This is not a Developer ID Installer, Apple Development, or Mac App Store certificate. Retain the private key securely; a downloaded `.cer` alone cannot sign the app. See [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
2. In Keychain Access, export the Developer ID Application certificate **and its private key** as a password-protected `.p12`. Use a unique strong export password. Record the exact `Developer ID Application: … (TEAMID)` identity and its 10-character team ID. Keep an encrypted, access-controlled recovery copy under the certificate custodian's policy; do not revoke or recreate the identity merely to run CI.
3. The Account Holder requests App Store Connect API access if needed. An **Account Holder or Admin** then creates a **team API key** authorized for notarization under App Store Connect → Users and Access → Integrations. Use Apple's currently supported notarization role/access policy. This workflow uses the team key's `.p8`, key ID, and issuer UUID; it does not use an individual key or an Apple ID/app-specific-password login. Download the private key once and store it securely. See [App Store Connect API keys](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/) and [notarization credentials](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
4. Transfer the P12, its password, and P8 to environment secrets through an approved private channel. Encode each file as a **single unwrapped base64 string** on the custodian's Mac; never print it to a terminal or put the value in a shell argument/history. The password is stored literally, not base64-encoded. Do not use a cloud-managed certificate that cannot export the private key required by this lane.

### GitHub environment and protection

Create a GitHub environment named `desktop-signing` under repository **Settings → Environments** before adding credentials:

- Use the **solo-maintainer approval policy**: add the maintainer as a required reviewer, leave **Prevent self-review** disabled, and disable administrator bypass. The maintainer may explicitly approve their own signing run, but a required manual environment approval must remain; self-review permission is not automatic approval. Before approving each native architecture, manually inspect the exact workflow ref, immutable source SHA already on `main`, dependency/lockfile changes, and packaging/build scripts. All code executed with the imported keychain can use signing authority. Self-approval does **not** provide independent review: a compromised maintainer account can approve signing. Environment approval is a deliberate pause, not a sandbox or protection against that account compromise. Fork pull requests use only unsigned CI.
- Select **Selected branches and tags** and allow exactly branch `main` and tag pattern `v*.*.*`, as separate typed policies. Do not allow arbitrary feature branches or rely on a broad `*` rule. Manual candidate dispatch uses `main`; tag-driven publication uses the immutable version tag. The workflow also rejects other execution refs and requires the requested source SHA to be an exact commit already on `main`.
- Protect `main` through reviewed pull requests and required checks, including changes to workflows, packaging scripts, and lockfiles. Restrict creation of release tags to authorized maintainers and prohibit their update/deletion through repository rulesets. A tag-pattern deployment policy only matches names; it does **not** make a tag immutable or prove code review. The preflight below does not audit these rulesets or reviewer trust.
- If the repository plan/visibility does not support required reviewers with self-review allowed, no administrator bypass, or typed deployment policies, do not put keys in an unprotected substitute. Resolve the account/protection limitation first.

Provision these values **on this environment**, not as broadly available repository secrets or variables:

| Kind | Name | Value to provision |
| --- | --- | --- |
| Secret | `DESKTOP_MAC_CERTIFICATE_BASE64` | Base64-encoded Developer ID Application certificate and private key exported as a password-protected P12. |
| Secret | `DESKTOP_MAC_CERTIFICATE_PASSWORD` | P12 export password. |
| Secret | `DESKTOP_MAC_NOTARY_KEY_BASE64` | Base64-encoded App Store Connect team API private key for notarization. |
| Variable | `DESKTOP_MAC_SIGNING_IDENTITY` | Exact Developer ID Application identity selected for signing. |
| Variable | `DESKTOP_MAC_TEAM_ID` | Apple's 10-character team identifier; must match the actual Developer ID signature. |
| Variable | `DESKTOP_MAC_NOTARY_KEY_ID` | Notarization API key identifier. |
| Variable | `DESKTOP_MAC_NOTARY_ISSUER` | Team API issuer identifier. |

Use GitHub's environment-secret UI, or have the custodian run these macOS commands after replacing the local file paths. They pipe encodings directly to GitHub; the final command prompts privately for the P12 password:

```sh
set -o pipefail
base64 -i /private/path/DeveloperID.p12 | tr -d '\r\n' | gh secret set DESKTOP_MAC_CERTIFICATE_BASE64 --repo dankhole/quarterdeck --env desktop-signing
base64 -i /private/path/AuthKey.p8 | tr -d '\r\n' | gh secret set DESKTOP_MAC_NOTARY_KEY_BASE64 --repo dankhole/quarterdeck --env desktop-signing
gh secret set DESKTOP_MAC_CERTIFICATE_PASSWORD --repo dankhole/quarterdeck --env desktop-signing
```

Do not use a `--body` argument containing secret material, echo secrets in a shell, enable shell tracing, upload them as artifacts, or commit temporary exports. Clear temporary plaintext exports and clipboard contents after verified provisioning, retaining only the approved secure backup. Manage rotation/revocation with the Apple account custodian; replacing an expired or compromised credential requires fresh signed-candidate validation.

The workflow validates public identifier formats before building, imports credentials into an isolated temporary runner keychain, and stores a `notarytool` profile there. Exported P12/P8 files are removed immediately after import. Its unconditional cleanup attempts keychain deletion and removes the entire private signing directory even if that deletion fails; cleanup failure fails the job. No signing material belongs in Actions artifacts or the repository. An abruptly lost runner cannot execute cleanup, so this lane uses disposable GitHub-hosted runners, never a persistent self-hosted signing host without a separate custody design. [Apple Developer ID distribution](https://developer.apple.com/developer-id/), [Forge signing configuration](https://www.electronforge.io/guides/code-signing/code-signing-macos)

### Read-only signing preflight

With Node 22+ and authenticated GitHub CLI access to environment/protection metadata, run from the repository root (no npm dependencies are needed):

```sh
node .github/scripts/desktop-signing-preflight.mjs --repository dankhole/quarterdeck
node --test .github/scripts/desktop-signing-preflight.test.mjs
```

The command only makes GitHub API **GET** requests. It checks environment existence, the selected solo-maintainer protection policy (required reviewer approval, self-review allowed, administrator bypass disabled), exact deployment-ref policies, required **secret names**, nonblank required environment variables, and that repository `QUARTERDECK_DESKTOP_RELEASES` is not `1`. Variable values are reduced to booleans inside `gh`; neither values, reviewer identities, nor raw API errors are printed. It never reads secret contents, imports keys, validates Apple credentials, builds, dispatches workflows, or changes GitHub configuration.

The tests use injected GitHub metadata on every platform. Their Bash workflow fixtures run only on POSIX hosts and are skipped on Windows; static workflow checks remain cross-platform. These are source-only checks with synthetic identifiers/files and a stubbed keychain command, not Apple signing/notarization or native release evidence.

Exit zero means only that these metadata checks passed while publication remains disabled. Exit one includes `fail` for missing/unsafe configuration and `unknown` for failed or unrecognized reads; both block readiness. A missing environment is identified only after a successful environment-list response. An isolated 404 may mean denied access and remains unknown, not proof of absence. Use an appropriately authorized maintainer login if metadata access is denied; do not weaken environment protections to make a check pass. Confirm manually that the configured required reviewer is the intended maintainer; the checker validates reviewer metadata, not that person's identity or trust. Organization-level overrides, main/tag rulesets, certificate expiry/private-key match, API permissions, signing/notarization, and the acceptance ledger remain separate manual checks.

After metadata is ready, an authorized maintainer may request a manual candidate build, review/approve the protected environment for **each native architecture**, and inspect the signed artifacts and job receipts. Only an actual successful Apple submission, nested-signature/team/entitlement and fuse audit, stapled app/DMG verification, and the clean-user/native execution gates establish distribution evidence. Keep publication disabled until those gates are recorded; a green preflight alone is insufficient.

`desktop-release.yml` supports manual candidate builds using a `source_sha` input: an exact 40-character commit SHA on `main`. It produces Actions artifacts only; manual dispatch does not publish npm, create tags, or publish a GitHub Release. Dispatch and account setup require the maintainer's authorization when performed.

The signed lane verifies the app and each bundled Mach-O helper/native module, validates the application's stapled ticket, and checks Gatekeeper assessment. Electron app/process executables and bundled Node receive only the JIT entitlement; native libraries receive an empty entitlement dictionary. The audit checks actual signatures, team identity, hardened-runtime flags, and exact entitlements on every Mach-O file. Library-validation exceptions and unsigned executable-memory allowances are not enabled. Signed native compatibility still requires the provisioned signing and clean-user gates. It then separately signs, notarizes, staples, and verifies the final DMG, recreates the ZIP from the stapled app, and finalizes checksums. Release fuses disable Electron run-as-Node, Node options, and CLI inspection. Unsigned lab inspection is not evidence that these release fuses work. [Electron notarization tooling](https://github.com/electron/notarize)

## Keychain continuity

Normal launches retain Chromium cookie encryption (`EnableCookieEncryption`). A **Quarterdeck Safe Storage** permission prompt belongs to Electron's macOS Keychain-backed encryption; shell environment import is independent. Ad-hoc builds, including public npm desktop releases, may prompt again after replacement because their identity is not stable across builds. Keep encryption enabled and disclose this limitation; do not claim prompt-free identity continuity. The optional protected Developer ID signing lane can provide a stable identity, subject to the checks below. [Electron signing requirements](https://www.electronjs.org/docs/latest/tutorial/code-signing#macos-apis-that-require-code-signing)

Before claiming repeated prompts are resolved, test signed N-to-N+1 builds on a clean user profile:

1. Verify both installed builds have the expected bundle identifier, Developer ID team and consistent signing identity, plus the required encrypted-cookie fuse and hardened-runtime settings.
2. Launch N normally, grant ordinary Keychain consent if requested, and create synthetic persisted authentication/cookie state.
3. Quit cleanly, replace through the normal verified installer, and launch N+1 from Finder/Dock. Confirm the existing encrypted state remains usable and there is no renewed identity-related Keychain prompt.
4. Record artifact identities, macOS version/architecture, consent observations and retained-state result in the [validation ledger](./desktop-validation.md). Test a fresh install separately from continuity across replacement.

These checks require provisioned credentials and actual signed installations. An unsigned Agent Lab run uses a mock keychain and cannot establish prompt elimination, Keychain access continuity, or Gatekeeper acceptance. Never reset the user's Keychain, broaden an item's access list, or disable encryption to make the test pass.

## Coordinated publication

For `adhoc-v1`, public ad-hoc desktop assets are mandatory without any signing credentials or repository flag. For `signed-v1`, repository `QUARTERDECK_DESKTOP_RELEASES=1` enables the required protected signing lane; provision and validate signing first. Both modes also require native unsigned Windows x64 and ARM64 assets; browser-only and partial-platform publication are rejected. Do not change distribution mode to repair an already-public release; retries validate and preserve its exact original assets against the immutable tag's expected policy. Root and desktop versions and lockfiles must agree. Preserve the squash-merge, immutable-tag, and OIDC rules in the main release runbook.

The mandatory publication order is:

1. Resolve the immutable tag SHA and pass the Linux/macOS/Windows matrix, including packed npm identity verification against that source SHA.
2. Inspect the GitHub Release before building. An already-public release is an immutable retry input: download and validate its original bytes, rather than signing new artifacts under the same names.
3. If no public asset set exists, build and verify ARM and Intel macOS artifacts in the tag's expected distribution mode, plus unsigned Windows x64 and ARM64 artifacts, from the exact SHA. Ad-hoc builds explicitly declare their mode and seal the bundle without Apple credentials; signed builds additionally require notarization. Each platform's two manifests must agree on version, source, clean status, npm update authority, channel, Electron/Node/ABI/root-lock identity, required release fuses and, on macOS, minimum OS. Per-architecture random build IDs may differ.
4. Upload a complete draft asset set and checksums, validate it, and publish the GitHub Release with the generated notes defined by the npm release workflow. Preview versions remain prereleases. Public retries preserve the original assets and notes.
5. Download the complete public assets anonymously and verify identities, sizes, and hashes. Private credentials succeeding is not proof that a fresh npm user can install.
6. Publish npm through the protected OIDC environment, or accept a retry only when the existing npm version and `gitHead` match the immutable source. Stable versions use `latest`; previews use an explicit prerelease tag.
7. Verify both registries and retain their artifact identities and run receipts.

The registries are independent. Public desktop assets may exist before npm publication succeeds; a retry reuses them. A published npm version cannot be overwritten. A public desktop asset cannot be replaced with a rebuilt or newly signed app. Any content repair requires a new product version. A draft may be rebuilt while still unpublished, but it must contain both architectures for both platforms from the validated source before promotion.

Each macOS architecture publishes:

- `Quarterdeck-X.Y.Z-darwin-ARCH.dmg`
- `Quarterdeck-X.Y.Z-darwin-ARCH.zip`
- `artifact-manifest-darwin-ARCH.json`

Each Windows architecture publishes `Quarterdeck-X.Y.Z-win32-ARCH.zip` and `artifact-manifest-win32-ARCH.json`. One shared `SHA256SUMS` binds the complete macOS/Windows set. ZIPs remain release artifacts; no Electron updater consumes them. The manifest records source SHA and cleanliness, product and dependency versions, Node ABI/archive hash, paired runtime/renderer build ID, root-lock hash, actual fuses, resource checksums, and container checksums. The npm package carries the same immutable source stamp. A local import additionally requires its exact paired build ID.

## npm update and recovery contract

The app checks the public npm registry once after startup and on explicit request. Stable installations follow `latest`; prereleases follow `preview`, matching publication tags. Available versions appear in the app and native menu without a startup modal. Local checkout installs instead show `npm run link` in that checkout and make no public checks. There is no Squirrel feed, background polling, or desktop-only update path. Do not infer installation ownership from the current shell's unrelated `npm` prefix.

An explicit update launches a private one-shot Terminal runner, waits for readiness, and authorizes it only through clean draft/session shutdown. The runner uses Node/npm outside the replaceable app and package, waits for app exit, rechecks ownership, and invokes npm with the exact selected version and owning prefix. npm configuration and script policy remain effective. `quarterdeck desktop status --json` prints one read-only status object and exits unsuccessfully unless the pair is ready without pending work; the runner additionally verifies the target version and owner. An npm zero exit with skipped hooks or a mismatched app is a failed update. Progress and pinned retry guidance stay visible in Terminal; success instructs the user to reopen the app. No persistent updater or automatic relaunch is installed.

Update discovery uses fixed public HTTPS metadata with bounded bodies and deadlines, validated semantic versions, and no arbitrary-host redirects. Main owns the state and invalidates a previous target as soon as refresh begins. Renderer access uses the separate optional `quarterdeckDesktopUpdates` namespace; preserve the original bridge shape for compatible older runtime UIs. IPC accepts fixed check/details intents rather than renderer-supplied versions, paths, arguments or commands, and retains frame/document/generation admission.

The external Node/npm toolchain and one-shot runner must live outside both replaceable trees, including the lifecycle PATH. Preparing or arming a runner cannot start npm. Only the synchronous final commit alongside clean app quit permits work after parent exit; a failed or cancelled precommit handoff must remain inert even if temporary-file writes fail. Renew the final draft seal after asynchronous acknowledgement. Failure after runtime shutdown exposes runtime recovery. The runner rechecks ownership immediately before mutation, never inherits the native installation-admission descriptor, and leaves visible pinned retry guidance on failure. Recognized temporary handoffs are bounded and cleaned conservatively; there is no permanent runner or app-version history.

The installer downloads or builds and verifies a replacement before it requests exclusive app admission. A live app or bundle-dependent process prevents replacement; it asks the user to quit and retry without killing sessions. Native admission must cover launches through Finder, CLI, and helpers before bundle-dependent code loads. A JavaScript process scan alone is insufficient proof. Preserve the permanent installation lock inode across uninstall and recovery.

Replacement journals its intent and staging allocation, retains the previous app only as a temporary backup, and restores or finalizes interrupted work deterministically. No permanent old-version collection is created. npm and the app cannot update as one transaction: CLI and Dock startup must identify missing owners, changed package slots, identity disagreement, and unfinished replacement before starting a runtime. Report the exact repair flow instead of silently launching a mixed pair.

`quarterdeck desktop status` is read-only. `quarterdeck desktop install` retries or repairs installation; `--replace-owner` explicitly adopts another prefix or checkout. `quarterdeck desktop uninstall` removes the app before `npm uninstall -g quarterdeck`. npm lifecycle hooks may be disabled or fail; `--ignore-scripts` is not evidence that desktop installation succeeded. A successful install/update must leave the matching desktop pair ready; there is no browser preference or browser-only update path. A missing/mismatched pair blocks startup until explicit repair. Transient `npx` use must not acquire desktop ownership.

## Required installation evidence

Before calling the release ready, record all of the following in the [validation ledger](./desktop-validation.md):

- Fresh global npm install, CLI launch, and Dock launch of the same expected-distribution pair on native ARM and Intel, including the declared minimum OS.
- N-to-N+1 replacement with app stopped; explicit refusal with app, runtime, recovery, renderer/GPU/utility helpers, or any other bundle-dependent process still alive.
- A launch racing replacement, including an already-loaded old native bootstrap; no process may execute replaced or mixed bundle bytes.
- Injected interruption at each durable transaction boundary; retry restores or finishes one valid pair and removes temporary backup/staging material.
- Missing/disabled lifecycle hooks, offline or corrupt downloads, full disk/permissions errors, concurrent installers, missing npm owner, owner changes, and same-version local rebuilds.
- Quarantined clean-user installation with Gatekeeper enabled, signature integrity/fuse verification, retained project/session storage, and clean owned-process shutdown. For ad-hoc distribution, record the actual warning/approval flow and any managed-policy refusal; never claim warning-free trust. Signed distribution additionally requires verified team/notarization and acceptance without an unidentified-developer exception.
- One-time migration of an actual old Dock shortcut and conservative treatment of unguarded legacy copies. Synthetic direct-path launch does not establish Dock alias migration.

The ordinary isolated Agent Lab redirects state and launches a noncanonical candidate. Its success does not prove the production installation admission path. The native-race fixture must compile a synthetic installation home into a copied bootstrap and exercise the same admission branch without changing the user's real Applications directory or lock. Production artifacts must never contain that test root.

Clean-user macOS approval, Intel/minimum-OS execution, actual Dock alias migration, and sustained daily use are external acceptance gates until executed and recorded. Apple credentials and trusted-signature continuity are additional gates only for the optional signed lane. Do not replace native evidence with source tests or claim an ad-hoc candidate is Apple-notarized.
