# Quarterdeck release workflow

This is the maintainer runbook for publishing Quarterdeck to npm and creating the matching GitHub Release. The supported path is a squash-merged release-prep pull request followed by an immutable tag on the resulting `main` commit. Do not create a second release branch after the merge and do not publish from a workstation.

## One-time publishing configuration

The npm package must have a trusted publisher with these exact values:

- Provider: GitHub Actions
- Organization or user: `dankhole`
- Repository: `quarterdeck`
- Workflow filename: `publish.yml`
- Environment: `npm-publish`

The GitHub repository must contain an `npm-publish` environment. `.github/workflows/publish.yml` requests `id-token: write` and associates its publish job with that environment. Together, these settings let GitHub Actions publish through short-lived OIDC credentials; maintainers do not put an npm token in GitHub Secrets or run `npm publish` locally.

After changing the npm-side relationship, verify it with the pinned repository npm version:

```bash
npx --yes npm@11.19.1 trust list quarterdeck
```

Account security changes are completed on npmjs.com. On macOS, open the relevant page in Firefox explicitly when needed:

```bash
open -a Firefox https://www.npmjs.com/settings/dankhole/tfa
```

## Prepare the release pull request

1. Start a release-prep branch from the latest `main`.
2. Choose a version that does not already exist on npm.
3. Update the root and desktop package manifests and lockfiles together without creating a tag:

   ```bash
   npm version --no-git-tag-version X.Y.Z
   npm --prefix desktop version --no-git-tag-version X.Y.Z
   ```

4. Review merged pull-request titles and descriptions for clear user-facing outcomes. GitHub generates release notes from the release tag and its pull-request history; there is no maintained changelog or chronological implementation log.
5. Update the current setup, behavior, or operational documentation where it changed, including upgrade guidance for breaking changes. Remove completed items from `docs/qDeck.yaml`. Record a separate decision or incident document only when durable rationale or recovery evidence warrants it.
6. Validate the publishable artifact and the changed behavior. At minimum for packaging changes:

   ```bash
   npm run build
   npm run test:package
   ```

   Follow `docs/testing.md` for any additional change-specific validation. Pull-request CI runs the complete Linux, macOS, and native Windows release matrix.
7. Commit, push, and open a pull request to `main`. Wait for every required check, then squash-merge it.

Do not tag the prep branch. The release tag must identify the squash commit that actually landed on `main`.

## Tag the squash-merged commit

Resolve the remote `main` SHA after the merge and inspect the version from that exact commit:

```bash
git ls-remote origin refs/heads/main
git show <main-sha>:package.json
```

Create and push an annotated tag at that SHA:

```bash
git tag -a vX.Y.Z <main-sha> -m "vX.Y.Z"
git push origin vX.Y.Z
```

Tags are immutable release inputs. Never move or force-push a release tag. If the tagged package is wrong, fix it in a new pull request and publish a new version.

## Publish from GitHub Actions

Pushing a version tag matching `v*.*.*` automatically starts the publishing workflow. The tagged commit must include the automatic trigger in `.github/workflows/publish.yml`; merge this configuration before tagging a new release. Ordinary branch pushes do not publish.

Manual dispatch remains available for retries or an existing tag that predates the automatic trigger:

```bash
gh workflow run publish.yml \
  --repo dankhole/quarterdeck \
  --ref main \
  -f tag=vX.Y.Z
```

Open the workflow in Firefox if desired:

```bash
open -a Firefox "https://github.com/dankhole/quarterdeck/actions/workflows/publish.yml"
```

Both triggers share a per-tag concurrency group and resolve one immutable source SHA. The Linux/macOS/Windows matrix validates that exact source, including the packed npm build stamp. Unified releases require matching signed desktop assets; signing cannot be disabled to bypass a failure. See the [desktop release runbook](docs/desktop-release.md) for provisioning and remaining [validation gates](docs/desktop-validation.md).

The workflow inspects publication state before signing. For a new release, it builds and verifies both native architectures, asks GitHub's [generated release notes API](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release) for notes using the exact tag and resolved source SHA, prepares the complete draft, publishes the GitHub Release, and verifies an anonymous download of every public artifact before npm publication. Draft retries regenerate notes before promotion. A retry of an already-public release preserves its notes, reuses its exact bytes, and skips rebuilding; public assets are immutable.

The npm job validates the version and source stamp. It publishes through OIDC only if the version is absent. An existing version is accepted only when its `gitHead` equals the immutable tag SHA. Stable releases use `latest`; previews specify a prerelease tag so they cannot replace `latest`. Missing or mismatched identity fails closed and requires a new version.

Monitor the run to completion:

```bash
gh run list --repo dankhole/quarterdeck --workflow publish.yml --limit 1
gh run watch <run-id> --repo dankhole/quarterdeck --exit-status
```

If npm publication fails after desktop publication, rerun the same immutable tag and reuse the public assets. If tagged content or any public artifact needs repair, prepare a new version. Never move the tag, overwrite public desktop bytes, or republish an accepted npm version. Draft assets may be rebuilt only before publication.

## Verify the release

Completion means both registries show the release:

```bash
npm view quarterdeck@X.Y.Z version dist-tags.latest repository bin engines --json
gh release view vX.Y.Z \
  --repo dankhole/quarterdeck \
  --json tagName,name,url,isPrerelease,publishedAt,targetCommitish
```

For a browser-package smoke test, use an isolated prefix and explicitly disable desktop lifecycle installation. A temporary prefix alone does not isolate the per-user app:

```bash
RELEASE_PREFIX="$(mktemp -d)"
QUARTERDECK_INSTALL_MODE=browser npm install --global --prefix "$RELEASE_PREFIX" quarterdeck@X.Y.Z
"$RELEASE_PREFIX/bin/quarterdeck" --version
```

Remove the temporary directory after verification. The user-facing install paths are:

```bash
npm install --global quarterdeck
npx --yes quarterdeck@latest --browser
```

npm does not automatically upgrade global installations. Existing users update explicitly with `npm install --global quarterdeck@latest`; the `npx` form resolves the current `latest` release and may reuse npm's download cache.

## Expected failure cases

Publishing stops when the tag is missing or malformed, the tag and package version differ, GitHub cannot generate nonempty notes for a new or draft release, the release matrix fails, OIDC does not match the npm trusted-publisher configuration, or the complete public desktop asset set cannot be verified. An already accepted immutable npm version is a retry state, never permission to overwrite it.
