# Quarterdeck Agent Instructions

`AGENTS.md` is the canonical repo-owned shared agent-instructions file. Keep `CLAUDE.md` as a tiny Claude Code compatibility shim that imports only `@AGENTS.md`; link human guides normally so they are read selectively. Do not duplicate shared rules or project documentation there. Human-facing setup, architecture, and developer guidance belongs in `README.md`, `DEVELOPMENT.md`, or `docs/`.

This file contains universal rules and routes specialized work to the smallest relevant reference. Read a routed document before changing that area; do not bulk-read unrelated convention or history documents.

## Maintaining these instructions

Add high-signal guidance when an issue required user correction, several failed attempts, a non-obvious cross-file investigation, or behavior that contradicted reasonable expectations. Record durable architecture and forensic detail in the relevant project document; keep only the universal rule or routing trigger here. Do not add routine facts discoverable from a few files.

When changing the instruction bridge, run `npm run check:agent-instructions`. Do not run the full runtime test suite solely for an instruction-only edit.

## Core engineering rules

### TypeScript

- Avoid `any` unless no sound alternative exists.
- Inspect installed dependency types instead of guessing external APIs. Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions.
- Use standard top-level imports. Never use dynamic imports for types, `await import("./foo.js")`, or `import("pkg").Type` type positions.
- Never remove or downgrade working code to accommodate stale dependency types; upgrade the dependency.

### Code quality and architecture

- Write production-quality code with small, single-responsibility modules and explicit ownership boundaries.
- Extract shared domain logic into hooks, services, or pure utilities. Prefer maintainability and navigability over line-count reduction.
- Avoid thin one-call-site wrappers that only forward props or relocate JSX. Extract state, effects, validation, or orchestration before presentation-only pass-through layers.
- Before adding custom utility code, consider whether a well-maintained dependency meaningfully reduces complexity and maintenance cost.
- Keep correctness separate from caching, batching, retry, preload, recovery, and other performance policy. Read `docs/conventions/architecture-guardrails.md` before adding such behavior.

### Supported agents

Claude Code, Codex, and Pi are supported desktop task-agent targets. Pi support is pinned to the exact validated release declared in `src/config/agent-registry.ts`; do not accept newer Pi releases until their lifecycle, trust, interaction, and exact-resume contracts pass the compatibility suite.

## Work-area routing

Read the referenced document before editing the listed area:

- Frontend work under `web-ui`: `docs/conventions/web-ui.md`.
- Browser/runtime API or WebSocket contract changes: the compatibility-version policy in `DEVELOPMENT.md#browserruntime-compatibility`.
- Hook/domain extraction or provider/context contracts: `docs/conventions/frontend-hooks.md`.
- Main views, sidebars, toolbar tabs, task-detail routing, or surface navigation: `docs/conventions/ui-layout.md`.
- Durable board state, board commands/receipts, lifecycle board transitions, authoritative hydration, project-scoped projections, automatic titles, notifications, or task indicators: `docs/conventions/runtime-state.md`.
- Project naming, folder availability, or project relocation: `docs/project-management.md`.
- Task-agent start/stop/resume/restart, startup recovery, session reconciliation, PTY identity, terminal restore, agent adapters, native hooks, input state, or host process launches: `docs/conventions/session-lifecycle.md`.
- Diagnostics recorder, journal, panel delivery, doctor, capture, or bundle format: `docs/diagnostics.md`.
- Native desktop shell, packaging, preload, runtime admission, process custody, or desktop/browser attachment: `docs/desktop.md`; distribution and updates also require `docs/desktop-release.md`.
- Test selection, validation scope, or deciding whether a heavier testing lane is justified: `docs/testing.md`.
- Structured/non-PTY execution or provider-session handoff: `docs/conventions/structured-execution.md`.
- Current architecture priorities or active refactors: `docs/qDeck.yaml` (the local, gitignored Chit source of truth) and the specific linked plan. Keep the list in the primary checkout; worktrees must use that same file with an explicit `--file` path rather than create copies. Use `chit --file docs/qDeck.yaml read` from the primary checkout before updates, preserve existing IDs, and use expected-value edits. `docs/todo.md` points to the frozen migration snapshot; do not maintain tasks there.

Tracked historical context lives under `docs/history/`. Read it only when current docs and code do not answer the question or the user explicitly requests archival context.

## Runtime ownership guardrails

- `ProjectBoardCommandService` is the only production writer of durable board state. Browsers and future clients submit typed intent and may show optimistic presentation; they never replace `board.json` or coordinate managed lifecycle effects themselves.
- Managed task lifecycle intent goes through `ProjectTaskLifecycleService`. Process-side transition consequences go through `SessionTransitionController`.
- Soft Trash must preserve task work and provider resume identity. Keep cleanup separate from the explicit permanent-delete intent; follow the Trash recovery contract in `docs/conventions/session-lifecycle.md`.
- Runtime session truth comes from the server-owned terminal/session store. Terminal output and input/submit intent are not proof that an agent is working; only a current launch-scoped native provider hook may assert resumed work.
- `applyAuthoritativeProjectState(...)` is the single browser apply path for authoritative project state.
- `IRuntimeHostIntegrations` is the sole production boundary for server-side file, application, URL, IDE, and folder-picker effects. Preserve its launch-derived capability checks and typed outcomes; never accept arbitrary browser-supplied commands.
- Do not start Quarterdeck runtime or dev instances (`npm run dev`, `npm run dev:full`, `npm run dogfood`, `quarterdeck`) without asking when the user's app may already be running. Overlapping runtimes can proxy to the wrong instance. Use build/test validation or the isolated Agent Lab as appropriate.
- Agent display availability is not launch authority. Task launches must use `resolveAgentCommandForLaunch(...)`; follow the cache, retry, and diagnostics policies in `docs/conventions/session-lifecycle.md#agent-availability-and-launch-admission`.

The summaries above are not substitutes for the routed runtime-state and session-lifecycle documents.

## Git and GitHub

- Never commit unless the user asks.
- When reading a GitHub issue, read every comment in one call:

  `gh issue view <number> --json title,body,comments,labels,state`

- When the user asks for a commit that closes an issue, include `fixes #<number>` or `closes #<number>` in the commit message.

## Release hygiene

Before preparing, tagging, publishing, retrying, or verifying an npm release, read `RELEASE_WORKFLOW.md` and follow its squash-merge, immutable-tag, OIDC publishing, and post-publish verification sequence.

## Documentation and completed work

Follow `docs/maintenance.md#documentation-lifecycle` when adding, moving, or substantially revising docs.

- Keep the README a concise install/use entry point. Put current behavior, setup, and troubleshooting in the owning guide; update that guide when the behavior changes.
- PR descriptions and Git history record routine changes and validation; GitHub release notes are generated from merged PRs. Do not maintain a changelog, append implementation-log entries, or create a replacement chronological work diary. Preserve consequential rationale or incidents in the owning guide under the documentation-lifecycle policy.
- Document required user action for breaking changes or migrations alongside the affected workflow, and call it out in the release PR. Generated release notes do not replace upgrade instructions.
- Remove a completed active item from the primary checkout's Chit list when accessible and authorized; preserve task IDs and expected-value edits. Completion does not require a new documentation entry. Do not create a worktree task-list copy if the tracker is unavailable.
- Archive completed plans and verbose validation evidence under `docs/history/`; retain current constraints and unresolved gates in their owning guides and preserve reference paths. Archived findings are not current instructions or proof of release readiness.

## Configuration changes

Before adding a global config field or Settings control, follow the checklist at the top of `src/config/global-config-fields.ts` for schemas, form mapping, and fixtures.

Avoid broad edits to copied config mocks during feature work. Prefer the shared runtime-config factory; if repeated fixtures remain, defer mechanical updates to a final pass or consolidate them behind `createDefaultMockConfig()` to reduce merge conflicts.

## Validation

- Follow `docs/testing.md` and run the smallest validation set that proves the changed invariant. Locally that means focused tests and the changed lanes' typechecks; full suites belong to CI.
- Test fixtures that redirect `HOME` must also redirect or remove `QUARTERDECK_STATE_HOME`, which takes precedence over the home directory. Root Vitest strips inherited `QUARTERDECK_*` launcher settings and creates a temporary default `HOME`/`USERPROFILE` with global-setup cleanup; preserve that isolation so fallback paths never target an active instance's state.
- Do not run an umbrella command and its constituent commands on the same unchanged tree. Reconcile the final base before relying on CI's broad gate, and re-run only validation affected by later changes.
- Documentation-only work does not require runtime or browser tests. Validate the instruction bridge only when it changed and check only links added or modified.
- Use the deterministic Agent Lab only when browser/runtime/PTY, persistence, Git/Files, host-integration, or visual behavior is part of the claim. Use screenshots only for visual claims and `restart-runtime` only for cold-start or recovery claims.
- Use a real provider only with explicit authorization and only when provider TUI, hooks, event ordering, version compatibility, or launcher behavior is the unresolved risk.
- When Agent Lab is selected, use the repo-owned `quarterdeck-functional-testing` skill. Never attach automation to the user's active Quarterdeck instance or substitute `npm run dev`, `npm run dev:full`, `npm run dogfood`, or `quarterdeck` for the lab.
- Use only synthetic lab data and always stop the run. The lab isolates data and processes but is not a hardened security sandbox.
- Mutable dependency directories such as `node_modules` are never shared into task worktrees. Never follow or mutate a legacy dependency symlink target.

## Diagnostics

Begin live-instance investigation with `quarterdeck diagnostics list|status|doctor|capture|watch`; do not ask the user to reproduce after enabling logging. Inspection is read-only, through authenticated runtime access or the retained local desktop journal: it must not connect as a board client, write project state, attach or resize a PTY, refresh Git, or repair anything.

Preserve the single bounded recorder and production privacy boundary. Read `docs/diagnostics.md` for capture policy, synthetic evidence, and bundle analysis.
