# Quarterdeck npm release workflow

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
npx --yes npm@11.19.0 trust list quarterdeck
```

Account security changes are completed on npmjs.com. On macOS, open the relevant page in Firefox explicitly when needed:

```bash
open -a Firefox https://www.npmjs.com/settings/dankhole/tfa
```

## Prepare the release pull request

1. Start a release-prep branch from the latest `main`.
2. Choose a version that does not already exist on npm.
3. Update both package manifests without creating a tag:

   ```bash
   npm version --no-git-tag-version X.Y.Z
   ```

4. Keep `## [Unreleased]` at the top of `CHANGELOG.md` and add a non-empty `## [X.Y.Z] - YYYY-MM-DD` section beneath it.
5. Apply normal release hygiene: remove completed items from `docs/todo.md` and include the user-visible changes in the new changelog section.
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

Pushing a tag does not publish automatically. Dispatch the manual workflow using the existing tag:

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

The workflow first runs the reusable release test matrix. Its publish job then:

1. Checks out the exact tagged commit.
2. Validates the tag format and its match with `package.json`.
3. Requires a non-empty matching changelog section.
4. Runs `npm publish --access public`; npm's `prepublishOnly` lifecycle builds and checks the package before upload.
5. Publishes with npm provenance through the configured OIDC trusted publisher.
6. Creates a GitHub Release from the changelog entry and adds a comparison link when a previous tag exists.

Monitor the run to completion:

```bash
gh run list --repo dankhole/quarterdeck --workflow publish.yml --limit 1
gh run watch <run-id> --repo dankhole/quarterdeck --exit-status
```

If the workflow fails before npm accepts the package, fix the cause and rerun it with the same immutable tag only when the tagged contents remain correct. npm versions cannot be overwritten; if npm accepted the package but a later step failed, do not republish that version. Repair or recreate only the missing GitHub Release, or prepare a new patch version if package contents must change.

## Verify the release

Completion means both registries show the release:

```bash
npm view quarterdeck@X.Y.Z version dist-tags.latest repository bin engines --json
gh release view vX.Y.Z \
  --repo dankhole/quarterdeck \
  --json tagName,name,url,isPrerelease,publishedAt,targetCommitish
```

For a first-install smoke test, use an isolated temporary prefix so the maintainer's global link is untouched:

```bash
RELEASE_PREFIX="$(mktemp -d)"
npm install --global --prefix "$RELEASE_PREFIX" quarterdeck@X.Y.Z
"$RELEASE_PREFIX/bin/quarterdeck" --version
```

Remove the temporary directory after verification. The user-facing install paths are:

```bash
npm install --global quarterdeck
npx --yes quarterdeck@latest
```

npm does not automatically upgrade global installations. Existing users update explicitly with `npm install --global quarterdeck@latest`; the `npx` form resolves the current `latest` release and may reuse npm's download cache.

## Expected failure cases

Publishing stops when the tag is missing or malformed, the tag and package version differ, the changelog entry is missing or empty, the release matrix fails, OIDC does not match the npm trusted-publisher configuration, or npm already contains that exact version.
