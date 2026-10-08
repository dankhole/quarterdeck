# Desktop release runbook

The macOS app adds an opt-in distribution lane to the existing [npm release workflow](../RELEASE_WORKFLOW.md). This checkout prepares packaging, signing, and coordinated publication; no certificate or notarization credential is configured, and no desktop release has been published. See the [validation ledger](./desktop-validation.md) before enabling distribution.

The prerequisite npm release with runtime admission has not been published. The development artifacts still identify themselves as 0.12.8; that does not establish that a registry-installed 0.12.8 CLI supports desktop coexistence. Before desktop rollout, publish and verify the admission-capable CLI, record its actual first supported version here, and require users to stop or upgrade earlier runtimes. Until then, use the app and CLI from the same local paired build.

## Local unsigned candidate

For everyday source-checkout use, run this from the repository root:

```sh
npm run desktop:install
node dist/cli.js --desktop
```

`desktop:install` installs missing or outdated root, web UI, and desktop dependencies from their lockfiles, ensures Electron is installed, builds the paired runtime/UI, packages the native host architecture, and imports the `.app` into a new managed directory. It does not launch the app or modify an existing installation. Quit an older standalone candidate before the first managed launch. Use `node dist/cli.js --browser` for browser mode from the same build. Use `npm run link -- --desktop` to do the same preparation and app installation while also making this checkout available as the global `quarterdeck` command. Then launch with `quarterdeck --desktop`. Follow the active-runtime safeguards. Use `npm run desktop:build` to build without importing.

The npm launcher downloads only a matching signed public release from the fixed repository/tag, verifies its manifest and DMG size/checksum, mounts read-only, validates bundle identity and macOS signature/Gatekeeper policy, and imports without running bundled code during verification. `--from` is an explicit local-candidate import and is not evidence of signing or notarization. It requires the current desktop launch protocol marker; old candidates must be rebuilt. No installer removes quarantine or changes the user's Keychain. Public release downloads remain unavailable until the existing distribution gates are satisfied.

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

These local artifacts are unsigned, allow explicitly requested CLI inspection for the isolated test harness, and have automatic updates disabled. Normal startup does not open an inspector listener; a passing local candidate is not signed-release or sustained daily-use acceptance.

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
| Variable | `QUARTERDECK_DESKTOP_PRODUCTION_UPDATES` | Optional manual signed stable candidate opt-in. Coordinated publication derives production enablement from the immutable stable version; preview and validation candidates disable it. |
| Variable | `DESKTOP_MAC_NOTARY_KEY_ID` | Notarization API key identifier. |
| Variable | `DESKTOP_MAC_NOTARY_ISSUER` | Team API issuer identifier. |

Apple Developer membership, an authorized certificate custodian, and a functioning notarization account are prerequisites. The workflow imports credentials into a temporary runner keychain, stores a `notarytool` profile there, and removes keychain/P12/P8 files in an unconditional cleanup step. No signing material enters Actions artifacts or the repository. [Apple Developer ID distribution](https://developer.apple.com/developer-id/), [Forge signing configuration](https://www.electronforge.io/guides/code-signing/code-signing-macos)

`desktop-release.yml` supports manual candidate builds using a `source_sha` input: an exact 40-character commit SHA on `main`. It produces Actions artifacts only; manual dispatch does not publish npm, create tags, or publish a GitHub Release. Dispatch and account setup require the maintainer's authorization when performed.

The signed lane verifies the app and each bundled Mach-O helper/native module, validates the application's stapled ticket, and checks Gatekeeper assessment. Electron app/process executables and bundled Node receive only the JIT entitlement; native libraries receive an empty entitlement dictionary. The audit checks actual signatures, team identity, hardened-runtime flags, and exact entitlements on every Mach-O file. Library-validation exceptions and unsigned executable-memory allowances are not enabled. Signed native compatibility still requires the provisioned signing and clean-user gates. It then separately signs, notarizes, staples, and verifies the final DMG, recreates the update ZIP from the stapled app, and finalizes checksums. Release fuses disable Electron run-as-Node, Node options, and CLI inspection. Unsigned lab inspection is not evidence that these release fuses work. [Electron notarization tooling](https://github.com/electron/notarize)

## Enable coordinated publication

Keep repository variable `QUARTERDECK_DESKTOP_RELEASES` unset until the release gates pass and signing CI is provisioned. Setting it to exactly `1` makes the existing `publish.yml` require both signed architectures for every release. Do not toggle it off merely to bypass a desktop failure after desktop users rely on these releases.

The release still uses the existing squash-merged preparation, matching package versions/changelog, and immutable `vX.Y.Z` tag on the resulting `main` commit. Update `desktop/package.json` and its lockfile alongside the root manifests when bumping the product version. Desktop build/staging fails on version disagreement; the independent root build does not require Electron.

With the desktop setting enabled, the sequence is:

1. Resolve the immutable tag SHA and pass the existing Linux/macOS/Windows release matrix.
2. Build and verify signed/notarized ARM and Intel artifacts from that SHA.
3. Validate both manifests: exact version/SHA, clean source, signed/team/update-channel policy, release fuses, common Electron/Node/ABI/minimum OS/root-lock identity, complete DMG/ZIP pairs, byte sizes, and SHA-256 hashes. Stable public apps require production updates enabled; public previews require them disabled. Validation-channel candidates cannot be promoted.
4. Upload the complete asset set and `SHA256SUMS` to an unpublished draft. An existing public Release is rejected before asset mutation.
5. Publish npm using the existing `npm-publish` environment and OIDC trusted publisher, or accept a partial-run retry only when the existing npm version and `gitHead` match the immutable source SHA. Verify that identity after fresh publication too; missing or mismatched registry identity fails closed.
6. Finalize the GitHub Release with its changelog. Prerelease tags remain prereleases.

When the setting is unset, the npm/browser flow retains its existing release matrix and OIDC publication. Desktop signing is skipped. Both registries are independent; a failure after npm accepts a package cannot undo publication. Retry correct immutable inputs to finish the draft release; never move a tag or overwrite an npm version. Existing draft assets may be replaced during a retry, but public desktop assets require a new version. Re-run all release jobs when retrying desktop builds so the current attempt contains both architectures.

Each architecture's upload contains:

- `Quarterdeck-X.Y.Z-darwin-ARCH.dmg`
- `Quarterdeck-X.Y.Z-darwin-ARCH.zip`
- `artifact-manifest-darwin-ARCH.json`

The manifest records source SHA, clean-source status, product and dependency versions, Node ABI/archive hash, paired runtime/browser build ID, root-lock hash, actual Electron fuses, resource checksums, and final container checksums. Distinct architecture builds may have different paired build IDs. Their product version and source SHA must agree.

Before calling publication complete, verify npm metadata and GitHub Release assets per the existing runbook, independently download both artifact sets, validate `SHA256SUMS`, install through a quarantined clean-user download with Gatekeeper enabled, and perform the signed N-to-N+1 update on both architectures. Record the actual downloadable artifact checksums and run IDs in the validation ledger. CI checks alone do not complete these user-machine gates.

## Updater contract

The public Electron update service requires a public repository and signed macOS ZIPs. Canonical names include `-darwin-arm64` or `-darwin-x64`; DMGs are installation containers, not updater payloads. Enable the signed production feed policy when building approved stable production artifacts, including the first public release, after validating the asset, manifest, and feed contract. Users check for updates only after publication and installation; candidate tests do not contact the production feed. This is a signed build policy, not a runtime environment override: candidates built with the feed disabled must be rebuilt for production. Keep preview releases out of the stable feed. Main verifies the enclosing app with code-signing and Gatekeeper assessment, checks team identity, hardened runtime and actual release fuses, then compares the signed policy with the bundled runtime before enabling the fixed architecture feed. Unsigned, synthetic, preview, or unverifiable builds remain disabled. [Electron update service](https://github.com/electron/update.electronjs.org)

Before `quitAndInstall()`, obtain any required dirty-editor/session decision and await successful shutdown of an app-owned helper. Failed shutdown leaves the update pending. An attached CLI-owned runtime survives the application's quit. Normal Quit also uses coordinated shutdown because a downloaded update can apply on the next start. Updater-specific quit events provide final idempotent cleanup; they are not a cancellation gate. Test signed N-to-N+1 updates with a controlled feed before using the production service. [Electron updater API](https://www.electronjs.org/docs/latest/api/auto-updater)

The installer can reject asynchronously after `quitAndInstall()` returns. Quarterdeck keeps that update pending, releases the frontend transition seal for local draft review/export, and retains the verified clean helper-shutdown receipt. Retry still obtains a fresh dirty-work decision and clean completion before another install attempt; normal Quit remains available. The runtime does not restart automatically. If updater recovery itself fails, quit and reopen before retrying. The pinned [Electron macOS implementation](https://github.com/electron/electron/blob/v44.5.1/shell/browser/auto_updater_mac.mm) reports installer failures through the updater error event.

## Controlled signed update candidates

For the signed N-to-N+1 gate, the protected manual `desktop-release.yml` dispatch accepts optional `validation_feed_base`. Provide a canonical HTTPS base without credentials, query parameters or fragments; trailing slashes normalize to one. The production service hostname `update.electronjs.org` is rejected, including trailing-dot aliases. The workflow passes the separate validation base as `QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE` during packaging, disables production opt-in, and embeds `channel: validation` plus the base inside the app before signing. Packaging rejects unsigned validation feeds, production-plus-validation settings and prerelease validation versions. Main requires the same actual Developer ID/team/hardened/fuse assessment as production. There is no renderer or runtime environment override.

Use successive ordinary product versions N and N+1, matching root/desktop manifests and immutable main SHAs. Their signed policies must use the same approved validation base, signing team and supported architecture. The updater constructs `BASE/darwin-ARCH/VERSION`. Host that endpoint and the verified N+1 signed/stapled ZIP using the Squirrel server response contract: 200 with update JSON for N, and 204 when no newer update should install, including N+1. The JSON's `url` points to the architecture-specific ZIP. Use a controlled HTTPS host with a valid certificate; provisioning it or uploading signed candidates is an external action requiring maintainer authorization. [Squirrel server contract](https://github.com/Squirrel/Squirrel.Mac#server-support)

Record app/ZIP manifests and hashes before testing, then exercise no-update, Later, dirty editor/live-session decisions, safe restart, offline/corrupt-feed failures, installer-error recovery, retained storage and empty owned-process cleanup. Repeat on native ARM and Intel. Validation artifacts remain Actions candidates and are rejected by public-release validation even when signed and notarized. These mechanisms prepare the gate; no signed candidates or controlled feed have been exercised in this checkout.

On migration failures, use documented backup/recovery and a newer corrective release. Do not promise automatic downgrade after irreversible state changes.
