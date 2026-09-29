# CI performance research

Research date: 2026-09-29. Recommendations and timing models only; no workflow or test behavior changed.

The strongest first step is to split each existing OS/Node target into two independent jobs: root checks/tests, and build/package/frontend tests. The measured step timings model a reduction from 9m 34s–10m 14s to 5m 37s–5m 55s for Windows, and roughly 35–40% for the other targets. Keep all existing platform coverage initially. Frontend environment selection and selective Windows sharding are the next opportunities.

## Evidence and limits

- [PR #55 CI, run 36589520351](https://github.com/dankhole/quarterdeck/actions/runs/36589520351): successful final PR run, head `d40de3d83c3b60361a52a5d967cbb057c1688477`; checkout logs show CI tested synthetic merge `2f083f8a04f6943a003fdbb2dc6d8379666eccd0`.
- [v0.12.8 Publish, run 36591184879](https://github.com/dankhole/quarterdeck/actions/runs/36591184879): successful release matrix and publisher at `be50fce99d9c308c34af865138514953103afd17`. The PR head, tested merge, and release commit all resolve to tree `4372b5aad78e5e8391e5ad3c6afeea34702963c1`.
- [September 24 CI, run 36027658212](https://github.com/dankhole/quarterdeck/actions/runs/36027658212): historical comparison only. It had 200 root and 160 web test files, versus 229 root and 196 web files in the September 29 runs; it is not an identical-workload benchmark.
- Read job/step timestamps and complete logs with `gh run view <id> --repo dankhole/quarterdeck --json jobs` and `gh run view <id> --repo dankhole/quarterdeck --log`.
- Reviewed [reusable tests](../.github/workflows/test.yml), [CI triggers](../.github/workflows/ci.yml), [publish workflow](../.github/workflows/publish.yml), both package manifests and Vitest configurations, packaging/build scripts, and representative slow tests. After merging remote `main`, the worktree baseline is the release revision `be50fce99d9c308c34af865138514953103afd17`; the research document is the only pending change.

There are two current-tree samples, not enough to establish median or tail latency. All projections below assume equally available runners and similar cache/setup conditions. No alternative workflow was dispatched, dependencies installed, or local performance benchmark run. This worktree has no installed dependencies; a local macOS run would not establish hosted Windows performance anyway.

## Measured baseline

Values are PR / release, in minutes:seconds. Setup/tail includes checkout, toolchain/dependency installation, cleanup, and gaps between steps. Job times exclude time before that job starts.

| Target | Whole job | Setup/tail | Build | Package smoke | Root check | Web tests |
| --- | --- | --- | --- | --- | --- | --- |
| Linux Node 22 | 3:24 / 3:22 | 0:28 / 0:25 | 0:05 / 0:06 | 0:12 / 0:13 | 1:13 / 1:09 | 1:26 / 1:29 |
| Linux Node 24 | 3:02 / 3:47 | 0:20 / 0:30 | 0:05 / 0:05 | 0:13 / 0:14 | 1:05 / 1:19 | 1:19 / 1:39 |
| macOS Node 22 | 4:43 / 3:17 | 0:44 / 0:26 | 0:08 / 0:04 | 0:18 / 0:13 | 1:39 / 1:19 | 1:54 / 1:15 |
| Windows Node 22 | 10:14 / 9:34 | 1:26 / 1:23 | 0:08 / 0:08 | 1:13 / 1:24 | 4:19 / 3:57 | 3:08 / 2:42 |

The September 24 Windows job was 9:27. Windows slowness predates the latest frontend additions. The earlier conversation's 13-minute figure does not describe the final PR job; its measured execution was 10:14. That PR's test jobs began about 65 seconds after workflow creation, illustrating additional scheduling delay outside the table.

The current four targets already run concurrently. Within each target the steps are sequential. Within each Vitest invocation test files already run in parallel; neither config overrides the default worker count. Vitest documents that non-watch runs use available parallelism, so starting two unrestricted test processes on the same runner would compete for the same resources. Use separate jobs first. See [Vitest parallelism](https://vitest.dev/guide/parallelism) and [worker limits](https://vitest.dev/config/maxworkers).

This is a public repository. GitHub documents 4 CPU/16 GB standard Linux and Windows runners, and 3 CPU/7 GB ARM macOS runners for these labels. Windows cannot simply be explained as having half the advertised CPU allocation. The logs do not isolate filesystem, process-launch, antivirus, or machine-contention contributions. See [runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Recommended first change: eight jobs, same coverage

For each of the four existing targets, run these concurrently on separate fresh runners:

1. Root lane: checkout, pinned Node/npm, required dependency installation, `npm run check`.
2. UI/package lane: checkout, pinned Node/npm, root and web dependencies, `npm run build`, `npm run test:package`, `npm run web:test`.

Keep `focused_windows` as the existing small diagnostic mode. Preserve equivalent required-check gating when job names change; inspect repository rules before implementation. Publishing must still wait for every required lane and use the resolved release SHA.

The root integration helper launches `src/cli.ts` through `tsx`, rather than a built CLI. The package smoke requires the production build and stays behind it. Initial validation must still prove that root tests have no implicit dependency on artifacts/dependencies from the former build step. Keep both dependency installs initially if necessary; removing the root lane's web install is a separate small optimization after proving it is unnecessary.

Let `S` be measured setup/tail, `R` root check, `B` build, `P` package smoke, and `W` web tests:

- Current elapsed time: `S + B + P + R + W`.
- Two-lane modeled elapsed time: `S + max(R, B + P + W)`.
- Modeled total runner time: current total plus another `S` per target.

| Target | Current PR / release | Two-lane model PR / release | Modeled reduction |
| --- | --- | --- | --- |
| Linux Node 22 | 3:24 / 3:22 | 2:11 / 2:13 | 34–36% |
| Linux Node 24 | 3:02 / 3:47 | 1:57 / 2:28 | 35–36% |
| macOS Node 22 | 4:43 / 3:17 | 3:04 / 1:58 | 35–40% |
| Windows Node 22 | 10:14 / 9:34 | 5:55 / 5:37 | 41–42% |

This duplicates the entire observed setup/tail in the model and does not assume faster tests. Aggregate runner time rises about 14%: 21:23 to 24:21 for the PR sample, or 20:00 to 22:44 for the release sample. More jobs can add queueing; these are modeled execution times, not promised end-to-end completion times.

A three-lane split everywhere (root, web, package) models 5:20–5:45 on Windows, only 10–17 seconds faster than two lanes for these samples. That is four additional jobs and more repeated setup for little immediate improvement to the overall bottleneck. Reconsider it selectively after optimizing or sharding root tests.

## Frontend: avoid unnecessary DOM environments on every target

[Web Vitest config](../web-ui/vitest.config.ts) assigns `jsdom` to all 196 files. The logs explicitly report 196 environment creations per target:

| Target | Web test wall time PR / release | Environment share PR / release |
| --- | --- | --- |
| Linux Node 22 | 85.91s / 88.21s | 66% / 64% |
| Linux Node 24 | 78.73s / 97.79s | 67% / 67% |
| macOS Node 22 | 113.55s / 74.19s | 64% / 65% |
| Windows Node 22 | 186.24s / 159.84s | 72% / 71% |

These percentages describe summed tracked phases across workers, not fractions of wall time that can simply be subtracted. For example, Windows PR environment work totals 362.35 worker-seconds inside a 186.24-second test run. The [Vitest performance guide](https://vitest.dev/guide/improving-performance) explains this accounting.

An initial source scan found 110 `.test.ts` files and 86 `.test.tsx` files. Of the `.ts` files, 83 had no direct match for common DOM/rendering APIs. This is a candidate list, not proof of DOM independence: transitive imports and less common browser APIs require inspection. `notification-audio.test.ts`, for example, appears in the coarse list and needs closer review.

Start with clearly pure cases such as [path display](../web-ui/src/utils/path-display.test.ts), [branch names](../web-ui/src/utils/branch-utils.test.ts), and [drag rules](../web-ui/src/state/drag-rules.test.ts). Use explicit `@vitest-environment node` annotations or disjoint Vitest projects, with DOM setup scoped appropriately. Retain jsdom for actual DOM/hook/component contracts. Do not classify by `.ts` extension alone. Vitest supports [per-file environment selection](https://vitest.dev/config/environment).

Benchmark frontend `threads` separately with isolation retained. Consider VM pools only after checking cross-realm/module behavior and memory use. Avoid globally disabling isolation: tests mutate globals and module state. Root tests additionally load native/process integrations, so a universal pool switch is not justified. See [pool compatibility](https://vitest.dev/config/pool).

One concrete frontend hotspot is [diff-expansion.test.tsx](../web-ui/src/components/git/panels/diff-expansion.test.tsx): 27.6–30.9 seconds on Windows versus 13.5–16.8 seconds on Linux in these samples. It renders 620 lines, expands context ten times, and covers both unified/split renderers. The release already raises the large cases' timeout to 15 seconds because this workload can exceed the default on shared runners. Review fixture size and repeated rendering, preserving the 200-row deferral threshold, 80-row chunk crossings, selection, caret, and node-identity assertions. Its per-file time overlaps other files, so shortening it does not guarantee the same wall-time saving.

No frontend speedup percentage is established yet. Environment selection can reduce work across all targets, unlike sharding, which mainly buys wall time with more runners.

## Backend: selective sharding and fixture cost

Root Vitest wall time was 226.7–249.7 seconds on Windows. The tracked `tests` phase was 85%, versus only 13% importing modules. These results favor inspecting actual test/process work and sharding before changing the root worker pool.

| Windows file | PR / release test duration |
| --- | --- |
| `test/integration/state-streaming.integration.test.ts` | 57.1s / 51.0s |
| `test/integration/windows-native-smoke.integration.test.ts` | 38.4s / 34.5s |
| `test/runtime/git-commit.test.ts` | 36.8s / 33.0s |
| `test/integration/server-restart.integration.test.ts` | 31.0s / 27.8s |
| `test/runtime/git-conflict.test.ts` | 28.3s / 26.2s |
| `test/runtime/git-revert.test.ts` | 27.8s / 24.5s |

These files overlap in time. Their durations cannot be added to estimate the critical path.

Test two Windows root shards on separate runners, retaining forks/isolation. Vitest's built-in `--shard=1/2` and `--shard=2/2` distribute files, not individual test cases, so imbalance and long individual files limit scaling. Measure both shards before introducing custom scheduling. If reports are merged, label them by OS/Node/shard and retain every shard's exit status. See [Vitest sharding](https://vitest.dev/guide/improving-performance#sharding).

Sharding root alone after the two-lane split leaves the UI/package lane at 5:37–5:55. To move toward a 3–4 minute Windows target, also reduce web overhead or separate Windows package smoke from web tests. That combined target is an experiment goal, not a measured result. Linux root tests are already about a minute; additional Linux shards may cost more setup/queue time than they save.

Git fixture setup is another profiling candidate. `git-commit.test.ts` starts four Git processes to initialize/configure each repository. The [shared Git helpers](../test/utilities/git-env.ts) supply author/committer and line-ending configuration only to their own child processes; production calls under test use a separate environment and still rely on repository configuration. Those writes are not established as redundant. Measure whether consolidating configuration writes or fixture preparation can reduce process launches while preserving repository-local identity, line-ending, and branch settings for every caller. Keep real Git, PTY, shutdown, and state-stream integration coverage.

Do not blanket-enable concurrent test cases: state-stream tests explicitly serialize cases and modify process environment. Isolate independent fixtures first. Setup/teardown timing around runtime start/stop and Git fixture creation would distinguish useful work from repeated preparation; the current logs cannot do that.

## Smaller or separate opportunities

- **Static-check deduplication:** `npm run check` spends only about 4–10 seconds outside Vitest per target. Running instruction/Biome checks once saves work but is not the main latency improvement. Retain cross-platform builds/type resolution until their coverage is deliberately reassigned; avoid a new mandatory static job if its setup costs exceed the saving.
- **npm cache keys:** setup-node currently hashes only the root lockfile. Include both `package-lock.json` and `web-ui/package-lock.json` for lanes installing both. The global npm cache may already contain web packages; the problem is key invalidation, not proof that web downloads are never cached. setup-node caches package-manager data, not `node_modules`. See [setup-node caching](https://github.com/actions/setup-node#caching-global-packages-data).
- **Windows cache misses:** both current runs reported no npm cache, while Linux/macOS hit caches. The PR saved a cache that a tag cannot automatically reuse because PR caches are scoped to the merge ref. This explains why a successful PR cache save does not establish a release cache hit; the logs do not establish every reason for the absence of a usable main cache. See [cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).
- **Package smoke:** [the script](../scripts/package-artifact-smoke.mjs) deliberately uses a new npm cache as well as a fresh install/state directory. Windows global package installation alone took 59 seconds in the PR, within a 73-second smoke. Instrument pack/install/start/serve/stop/cleanup separately. A shared download cache could preserve fresh installation semantics, but would change cold-download coverage; evaluate that explicitly and retain a cold-cache acceptance run if required. Do not reuse installed dependency trees across jobs or operating systems.
- **Pinned npm:** its Windows install takes 24–29 seconds versus 2–6 seconds elsewhere. Preserve the pinned version and release-toolchain constraints. This overhead becomes more noticeable with shards; changing package managers or maintaining custom images is not the first step.
- **Build artifacts:** builds take 4–8 seconds. Building once and transferring artifacts across OS jobs is unlikely to justify the artifact handoff and loss of platform build coverage for this bottleneck.
- **Repeated release checks:** the release matrix repeats the identical PR tree, and then `npm publish` invokes `prepublishOnly`, which builds and runs root checks yet again. In the measured release the publisher took 2:17, including 81.48 seconds of root tests. A future trusted artifact promotion path could eliminate that repeated test execution. It must preserve exact commit/tree/artifact identity, immutable tags, tag/version/changelog validation, and OIDC publishing; it is a separate release-workflow change. Do not simply add `--ignore-scripts` to the existing publisher or accept any green PR as proof for a tag. Follow [the release runbook](../RELEASE_WORKFLOW.md).

## Experiment sequence and acceptance

1. Implement only the two-lane split for all four targets. Keep the same OS/Node combinations, assertions, package smoke, and exact-release-SHA gate. Expose root test versus static timing if splitting the `check` step for observability; do not also run the umbrella command.
2. Run a baseline and candidate on the same source tree/toolchain for at least three paired full matrices. Record runner labels/image, available parallelism, cache hits, queue delay, job time, per-file time, and total runner time. Distinguish warm/cold cache samples. Validate required-check wiring and that any failed lane blocks publishing without performing a publication.
3. Trial explicit Node environments for audited pure frontend tests; preserve total test discovery and intended platform skips. Compare once independently of workflow restructuring so savings can be attributed.
4. If Windows still dominates, trial two root shards and an independent Windows package job. Check shard balance, fixture isolation, flaky failures, and memory. Add shards on other targets only if their measured critical path warrants it.
5. Profile the named Git/process and diff-render fixtures. Pursue cache and release-promotion changes separately, with their own invariants.

Use a 5–6 minute Windows execution target for the first change. Treat 3–4 minutes as a later goal requiring measured frontend and backend improvements. Do not present arithmetic projections as achieved performance or add the estimated savings from overlapping changes together. No runtime/browser/provider testing is needed for this research document; implementation requires hosted CI evidence for the scheduling and platform claims.
