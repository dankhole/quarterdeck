# Desktop release runbook

The macOS app and npm CLI form one release in the [npm release workflow](../RELEASE_WORKFLOW.md). This checkout prepares packaging, signing, and coordinated publication; no certificate or notarization credential is configured, and no desktop release has been published. See the [validation ledger](./desktop-validation.md) before enabling distribution.

Do not publish the unified installation package before the matching signed ARM and Intel assets are publicly downloadable and all acceptance gates pass. npm lifecycle installation depends on those assets. Local unsigned builds remain available for development; their success does not establish signed distribution readiness.

## Local unsigned candidate

For everyday source-checkout use, run this from the repository root:

```sh
npm run link
quarterdeck
```

`npm run link` installs missing or outdated root, web UI, and desktop dependencies from their lockfiles, builds one paired runtime/UI/app, links this checkout, and imports it through the shared installer. Quit the current app before replacement; download/build and verification happen first. The stable app location is `~/Applications/Quarterdeck.app`. This command intentionally adopts the selected checkout as owner. Use `npm run link -- --browser` to opt out, or `npm run desktop:build` to build without installation. `--desktop` remains a compatibility alias for the default link behavior.

The npm lifecycle installer downloads only a matching signed public release from the fixed repository/tag, verifies its manifest and DMG size/checksum, mounts read-only, validates bundle identity and macOS signature/Gatekeeper policy, and imports without running bundled code during verification. `--from` is an explicit local-candidate import and is not evidence of signing or notarization. It requires the current desktop launch protocol marker; old candidates must be rebuilt. No installer removes quarantine or changes the user's Keychain. Public release downloads remain unavailable until the existing distribution gates are satisfied.

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

Substitute `x64` on Intel. Run these commands from the repository root; verification uses an absolute path because npm runs desktop scripts from `desktop/`. The root build stamps runtime/browser assets together; desktop commands consume those assets. The packaged helper contains pinned Node, production dependencies installed from the root lock, and Node-ABI native PTYs outside ASAR. Electron's dependencies and native ABI remain separate. Desktop tools do not enter the published npm runtime package.

These local artifacts use an ad-hoc signature, allow explicitly requested CLI inspection for the isolated test harness, and use source-checkout update guidance. They remain unsigned distribution candidates: they have no Developer ID identity or notarization. Packaging seals the completed app after metadata and fuse changes, and artifact verification checks signature integrity for local candidates as well as signed releases. An invalid signature can prevent macOS from requesting access to protected folders such as Desktop, leaving Git projects unavailable even when the same folders work in browser mode. Rebuild and import an affected candidate; do not initialize or relocate an existing repository to work around that failure. Normal startup does not open an inspector listener; a passing local candidate is not signed-release or sustained daily-use acceptance.

The DMG maker uses macOS `ditto` and `hdiutil` to preserve the packaged app in a compressed HFS+ volume with an Applications link. It uses a plain Finder view; no image parser or third-party DMG layout tooling is required. DMG signing and notarization remain separate release gates.

`desktop-ci.yml` uses explicit `macos-15` ARM and `macos-15-intel` runner labels, pinned Node/npm build tools, independent lockfiles, unsigned DMG/ZIP artifacts, and isolated fake-provider Electron smoke. It uploads synthetic lab evidence on success or failure. Its download is a prototype, not a signed installer. The corresponding [GitHub runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) identifies each label's architecture. It does not establish support on the macOS 13 minimum or prove signed Gatekeeper behavior.

## Provision signing once

Create a protected GitHub environment named `desktop-signing`. Restrict deployments to approved `main` and immutable version-tag inputs, require trusted reviewer approval, and prevent unreviewed workflow changes from obtaining credentials. Fork pull requests use only the unsigned CI workflow. Signing candidates must resolve to an exact commit already on `main`.

The environment needs these deliberately unpopulated values:

| Kind | Name | Value to provision |
| --- | --- | --- |
| Secret | `DESKTOP_MAC_CERTIFICATE_BASE64` | Base64-encoded Developer ID Application certificate and private key exported as a password-protected P12. |
| Secret | `DESKTOP_MAC_CERTIFICATE_PASSWORD` | P12 export password. |
| Secret | `DESKTOP_MAC_NOTARY_KEY_BASE64` | Base64-encoded App Store Connect team API private key for notarization. |
| Variable | `DESKTOP_MAC_SIGNING_IDENTITY` | Exact Developer ID Application identity selected for signing. |
| Variable | `DESKTOP_MAC_TEAM_ID` | Apple's 10-character team identifier; must match the actual Developer ID signature. |
| Variable | `DESKTOP_MAC_NOTARY_KEY_ID` | Notarization API key identifier. |
| Variable | `DESKTOP_MAC_NOTARY_ISSUER` | Team API issuer identifier. |

Apple Developer membership, an authorized certificate custodian, and a functioning notarization account are prerequisites. The workflow imports credentials into a temporary runner keychain, stores a `notarytool` profile there, and removes keychain/P12/P8 files in an unconditional cleanup step. No signing material enters Actions artifacts or the repository. [Apple Developer ID distribution](https://developer.apple.com/developer-id/), [Forge signing configuration](https://www.electronforge.io/guides/code-signing/code-signing-macos)

`desktop-release.yml` supports manual candidate builds using a `source_sha` input: an exact 40-character commit SHA on `main`. It produces Actions artifacts only; manual dispatch does not publish npm, create tags, or publish a GitHub Release. Dispatch and account setup require the maintainer's authorization when performed.

The signed lane verifies the app and each bundled Mach-O helper/native module, validates the application's stapled ticket, and checks Gatekeeper assessment. Electron app/process executables and bundled Node receive only the JIT entitlement; native libraries receive an empty entitlement dictionary. The audit checks actual signatures, team identity, hardened-runtime flags, and exact entitlements on every Mach-O file. Library-validation exceptions and unsigned executable-memory allowances are not enabled. Signed native compatibility still requires the provisioned signing and clean-user gates. It then separately signs, notarizes, staples, and verifies the final DMG, recreates the ZIP from the stapled app, and finalizes checksums. Release fuses disable Electron run-as-Node, Node options, and CLI inspection. Unsigned lab inspection is not evidence that these release fuses work. [Electron notarization tooling](https://github.com/electron/notarize)

## Coordinated publication

The desktop lane is mandatory for releases using unified installation. Provision and validate signing before publishing; a repository toggle must not produce a package whose required app is unavailable. Root and desktop versions and lockfiles must agree. Preserve the squash-merge, immutable-tag, and OIDC rules in the main release runbook.

The workflow order is:

1. Resolve the immutable tag SHA and pass the Linux/macOS/Windows matrix, including packed npm identity verification against that source SHA.
2. Inspect the GitHub Release before building. An already-public release is an immutable retry input: download and validate its original bytes, rather than signing new artifacts under the same names.
3. If no public asset set exists, build and verify signed/notarized ARM and Intel artifacts from the exact SHA. Both manifests must agree on version, source, clean status, npm update authority, channel, Electron/Node/ABI/minimum OS/root-lock identity, and required release fuses. Per-architecture random build IDs may differ.
4. Upload a complete draft asset set and checksums, validate it, and publish the GitHub Release. Preview versions remain prereleases.
5. Download the complete public assets anonymously and verify identities, sizes, and hashes. Private credentials succeeding is not proof that a fresh npm user can install.
6. Publish npm through the protected OIDC environment, or accept a retry only when the existing npm version and `gitHead` match the immutable source. Stable versions use `latest`; previews use an explicit prerelease tag.
7. Verify both registries and retain their artifact identities and run receipts.

The registries are independent. Public desktop assets may exist before npm publication succeeds; a retry reuses them. A published npm version cannot be overwritten. A public desktop asset cannot be replaced with a newly signed build. Any content repair requires a new product version. A draft may be rebuilt while still unpublished, but it must contain both architectures from the validated source before promotion.

Each architecture publishes:

- `Quarterdeck-X.Y.Z-darwin-ARCH.dmg`
- `Quarterdeck-X.Y.Z-darwin-ARCH.zip`
- `artifact-manifest-darwin-ARCH.json`

ZIPs remain release artifacts; no Electron updater consumes them. The manifest records source SHA and cleanliness, product and dependency versions, Node ABI/archive hash, paired runtime/browser build ID, root-lock hash, actual fuses, resource checksums, and container checksums. The npm package carries the same immutable source stamp. A local import additionally requires its exact paired build ID.

## npm update and recovery contract

The app checks the public npm registry once after startup and on explicit request. Stable installations follow `latest`; prereleases follow `preview`, matching publication tags. Available versions appear in the app and native menu without a startup modal. Local checkout installs instead show `npm run link` in that checkout and make no public checks. There is no Squirrel feed, background polling, or desktop-only update path. Do not infer installation ownership from the current shell's unrelated `npm` prefix.

An explicit update launches a private one-shot Terminal runner, waits for readiness, and authorizes it only through clean draft/session shutdown. The runner uses Node/npm outside the replaceable app and package, waits for app exit, rechecks ownership, and invokes npm with the exact selected version and owning prefix. npm configuration and script policy remain effective. `quarterdeck desktop status --json` prints one read-only status object and exits unsuccessfully unless the pair is ready without pending work; the runner additionally verifies the target version and owner. An npm zero exit with skipped hooks or a mismatched app is a failed update. Progress and pinned retry guidance stay visible in Terminal; success instructs the user to reopen the app. No persistent updater or automatic relaunch is installed.

The installer downloads or builds and verifies a replacement before it requests exclusive app admission. A live app or bundle-dependent process prevents replacement; it asks the user to quit and retry without killing sessions. Native admission must cover launches through Finder, CLI, and helpers before bundle-dependent code loads. A JavaScript process scan alone is insufficient proof. Preserve the permanent installation lock inode across uninstall and recovery.

Replacement journals its intent and staging allocation, retains the previous app only as a temporary backup, and restores or finalizes interrupted work deterministically. No permanent old-version collection is created. npm and the app cannot update as one transaction: CLI and Dock startup must identify missing owners, changed package slots, identity disagreement, and unfinished replacement before starting a runtime. Report the exact repair flow instead of silently launching a mixed pair.

`quarterdeck desktop status` is read-only. `quarterdeck desktop install` retries or repairs installation; `--replace-owner` explicitly adopts another prefix or checkout. `quarterdeck desktop uninstall` removes the app before `npm uninstall -g quarterdeck`. npm lifecycle hooks may be disabled or fail; `--ignore-scripts` is not evidence that desktop installation succeeded. Browser mode remains usable via `--browser`; `QUARTERDECK_INSTALL_MODE=browser` opts out of automatic app installation. Transient `npx` usage is browser-only and must not acquire desktop ownership.

## Required installation evidence

Before calling the release ready, record all of the following in the [validation ledger](./desktop-validation.md):

- Fresh global npm install, CLI launch, and Dock launch of the same signed pair on native ARM and Intel, including the declared minimum OS.
- N-to-N+1 replacement with app stopped; explicit refusal with app, runtime, recovery, renderer/GPU/utility helpers, or any other bundle-dependent process still alive.
- A launch racing replacement, including an already-loaded old native bootstrap; no process may execute replaced or mixed bundle bytes.
- Injected interruption at each durable transaction boundary; retry restores or finishes one valid pair and removes temporary backup/staging material.
- Missing/disabled lifecycle hooks, offline or corrupt downloads, full disk/permissions errors, concurrent installers, missing npm owner, owner changes, and same-version local rebuilds.
- Quarantined clean-user installation with Gatekeeper enabled, signature/team/fuse verification, retained project/session storage, and clean owned-process shutdown.
- One-time migration of an actual old Dock shortcut and conservative treatment of unguarded legacy copies. Synthetic direct-path launch does not establish Dock alias migration.

The ordinary isolated Agent Lab redirects state and launches a noncanonical candidate. Its success does not prove the production installation admission path. The native-race fixture must compile a synthetic installation home into a copied bootstrap and exercise the same admission branch without changing the user's real Applications directory or lock. Production artifacts must never contain that test root.

Signing credentials, clean-user Gatekeeper, Intel/minimum-OS execution, actual Dock alias migration, and sustained daily use are external acceptance gates until executed and recorded. Do not replace their evidence with source tests or claim an unsigned local candidate is a signed release.
