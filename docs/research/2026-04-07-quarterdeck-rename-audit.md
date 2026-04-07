# Research: Rename from "kanban" to "quarterdeck" -- Full Codebase Audit

**Date**: 2026-04-07
**Branch**: HEAD (detached)

## Research Question

Identify every reference to "kanban" across the entire codebase, categorize what must change vs what stays, flag migration-critical items that go beyond simple find-and-replace, and document the CSS `kb-` prefix scope.

## Key Assumption

**This project is not distributed yet.** There are no external users, no published npm package, and no production deployments. The only consumer is a single local development machine. This means every change is safe to make as a breaking change with no migration code -- just a straight codebase rename plus a short local cleanup (see guide at the end).

## Summary

The codebase contains **~780+ occurrences** of "kanban" (case-insensitive) across source code, tests, docs, config, and CI. The rename touches every layer: CLI binary name, environment variables, HTTP headers, git refs, filesystem paths, localStorage keys, CSS class prefixes, IPC protocols, PWA manifest, man page, and user-facing strings. All are simple find-and-replace -- no backward-compat, no dual-read logic, no migration functions.

## Categories

### A. MUST CHANGE -- Simple Find-and-Replace

These are internal identifiers, code comments, variable/function names, import paths, and test strings. No migration concern -- they only exist in source code.

#### Runtime Source (`src/`)

| Area | Files | What Changes |
|------|-------|-------------|
| Function/const names | `core/runtime-endpoint.ts` | `getKanbanRuntimeHost`, `setKanbanRuntimeHost`, `getKanbanRuntimePort`, `setKanbanRuntimePort`, `getKanbanRuntimeOrigin`, `getKanbanRuntimeWsOrigin`, `buildKanbanRuntimeUrl`, `buildKanbanRuntimeWsUrl`, `DEFAULT_KANBAN_RUNTIME_HOST`, `DEFAULT_KANBAN_RUNTIME_PORT` |
| Function/const names | `core/kanban-command.ts` | `resolveKanbanCommandParts`, `buildKanbanCommandParts`, binary regex `/kanban(?:\.(?:cmd\|ps1\|exe))?$/iu` |
| Function names | `prompts/append-system-prompt.ts` | `DEFAULT_COMMAND_PREFIX = "kanban"`, `kanbanCommand` variable |
| Const names | `terminal/hook-runtime-context.ts` | `KANBAN_HOOK_TASK_ID_ENV`, `KANBAN_HOOK_WORKSPACE_ID_ENV` |
| Const names | `workspace/task-worktree.ts` | `KANBAN_MANAGED_EXCLUDE_BLOCK_START/END`, `KANBAN_TRASHED_TASK_PATCHES_DIR_NAME`, `KANBAN_TASK_WORKTREE_SETUP_LOCKFILE_NAME` |
| Const names | `workspace/task-worktree-path.ts` | `KANBAN_RUNTIME_HOME_DIR_NAME`, `KANBAN_TASK_WORKTREES_HOME_DIR_NAME`, `KANBAN_TASK_WORKTREES_DIR_NAME`, `KANBAN_TASK_WORKTREES_DISPLAY_ROOT` |
| Internal property | `terminal/ws-server.ts`, `server/runtime-server.ts` | `__kanbanUpgradeHandled` property on IncomingMessage |
| Build identifier | `scripts/build.mjs:26-27` | `__kanban_createRequire` CJS shim banner |
| Session env | `terminal/session-manager.ts:200` | `TERM_PROGRAM: "kanban"` |
| Log prefixes | `cli.ts:395,424`, `terminal/session-manager.ts:1119` | `[kanban]` prefix in console/terminal output |
| CLI name | `cli.ts:551` | `.name("kanban")` |
| Version const | `cli.ts:37` | `KANBAN_VERSION` |
| User-facing strings | `cli.ts:92,258,342,348,484,570,577,606` | `"Kanban already running"`, `"Failed to start Kanban"`, etc. |
| User-facing strings | `trpc/projects-api.ts:79` | `"Kanban requires git to manage worktrees"` |
| User-facing strings | `workspace/task-worktree.ts:88` | `"Kanban cannot create a task worktree"` |
| User-facing strings | `workspace/initialize-repo.ts:34` | `"Initial commit through Kanban"` |
| Config comment | `config/runtime-config.ts:1-2` | Code comments mentioning Kanban |
| Codex session prefix | `commands/hooks.ts:647` | `kanban-codex-session-` temp file prefix |
| Codex agent directory | `terminal/agent-session-adapters.ts:1008` | Plugin file written as `kanban.js` |
| OpenCode plugin | `terminal/agent-session-adapters.ts:150-154` | `KanbanPlugin`, `globalThis.__kanbanOpencodePluginV3` |
| Codex wrapper desc | `commands/hooks.ts:754,801` | CLI description strings |
| HTTP header | `cli.ts`, `commands/task.ts`, `trpc/app-router.ts`, `server/runtime-server.ts` | `x-kanban-workspace-id` (all sides must change together) |
| Shutdown IPC | `test/integration/shutdown-ipc-hook.cjs` | `kanban.shutdown` message type |

#### Web UI (`web-ui/`)

| Area | Files | What Changes |
|------|-------|-------------|
| Component names | `kanban-board.tsx` | `KanbanBoard` |
| Component names | `kanban-access-blocked-fallback.tsx` | `KanbanAccessBlockedFallback` |
| Hook names | `use-kanban-access-gate.ts` | `useKanbanAccessGate`, `UseKanbanAccessGateInput` |
| Function names | `terminal/terminal-options.ts` | `createKanbanTerminalOptions`, `CreateKanbanTerminalOptionsInput` |
| Function names | `utils/tab-visibility-presence.ts` | `hasVisibleKanbanTabForWorkspace` |
| File renames | 4 files | `kanban-board.tsx`, `kanban-board.test.tsx`, `kanban-access-blocked-fallback.tsx`, `use-kanban-access-gate.ts` |
| Import paths | `App.tsx`, `use-programmatic-card-moves.ts`, tests | `@/components/kanban-board`, `@/hooks/kanban-access-blocked-fallback`, `@/hooks/use-kanban-access-gate` |
| Vite plugin name | `vite.config.ts:18` | `"kanban-selective-build-minify"` |
| Terminal log prefix | `persistent-terminal-manager.ts:511,517` | `"[kanban] ..."` |
| Console warn prefix | `runtime/use-runtime-config.ts:67,74` | `"[kanban][settings] ..."` |
| HTML title | `index.html:12` | `<title>Kanban</title>` |
| PWA manifest | `public/manifest.json:2-3` | `"name": "Kanban"`, `"short_name": "Kanban"` |
| Service worker | `public/sw.js:1,10,52,53` | Comment, HTML title, waiting text, CLI command |
| User-facing strings | `App.tsx`, `kanban-access-blocked-fallback.tsx`, `runtime-disconnected-fallback.tsx`, `project-navigation-panel.tsx`, `task-start-agent-onboarding-carousel.tsx`, `app-error-boundary.tsx`, `debug-dialog.tsx`, `runtime-settings-dialog.tsx`, `use-project-navigation.ts`, `use-review-ready-notifications.ts` | ~25 instances across 12 files |

#### Package/Config

| File | What Changes |
|------|-------------|
| `package.json:2,4,10,16,18,20,23,27,29,53` | name, description, keywords, homepage, bugs, author, repository, bin, man, unlink script |
| `web-ui/package.json:2` | `"@kanban/web"` |
| `package-lock.json:2,8,27` | name, bin (auto-regenerated) |
| `web-ui/package-lock.json:2,8` | name (auto-regenerated) |
| `.codex/environments/environment.toml:3` | `name = "kanban"` |

#### Man Page

| File | What Changes |
|------|-------------|
| `man/kanban.1` (entire file) | Rename to `man/quarterdeck.1`. Every reference to "kanban" and "Kanban" in the man page (~30 occurrences). Update `package.json` `"man"` field. |

#### CI/CD & GitHub

| File | What Changes |
|------|-------------|
| `.github/workflows/publish.yml:127,132` | Slack notification text: `"Kanban ${{tag}}"` |
| `.github/ISSUE_TEMPLATE/bug.yml:36` | `"Kanban version"` label |
| `.github/ISSUE_TEMPLATE/config.yml:4` | Feature requests URL -> new repo |

#### Tests

~200 occurrences across test files. All are internal identifiers, temp dir prefixes (`createTempDir("kanban-...")`), assertion strings, and test fixture data. Straightforward find-and-replace with the caveat that temp dir prefixes are cosmetic and could optionally stay.

#### Docs

| File | What Changes |
|------|-------------|
| `CLAUDE.md` | Title, description, fork reference, architecture examples, state paths |
| `AGENTS.md` | `@/kanban/utils/react-use` import path, user-facing strings, CLI command examples |
| `DEVELOPMENT.md` | CLI command examples, env var references, section titles |
| `CHANGELOG.md` | ~20 references (historical -- consider whether to rename in past entries or leave as-is) |
| `RELEASE_WORKFLOW.md:1` | Title |
| `README.md` | Title, description, CLI commands, npm links, user-facing text |
| `web-ui/README.md` | Title and description |
| `docs/README.md:3` | Section text |
| `docs/architecture.md` | ~20 references to "Kanban" as product name |
| `docs/planned-features.md` | ~15 references |
| `docs/performance-bottleneck-analysis.md` | ~3 references |
| `docs/research/*.md` | ~30 references across 4 research docs |
| `docs/plans/*.md` | GitHub URL references |

---

### B. Persisted State References (No Migration Code Needed)

Since this project has no external users yet (only local development), all of these are straight find-and-replace in the codebase. The local machine cleanup is handled via the manual migration guide at the end of this document.

#### B1. `~/.kanban/` State Directory

| File | Line | Constant | Value |
|------|------|----------|-------|
| `src/workspace/task-worktree-path.ts` | 3 | `KANBAN_RUNTIME_HOME_DIR_NAME` | `".kanban"` |
| `src/workspace/task-worktree-path.ts` | 4 | `KANBAN_TASK_WORKTREES_HOME_DIR_NAME` | `".kanban/worktrees"` |
| `src/state/workspace-state.ts` | 23 | `RUNTIME_HOME_DIR` | `".kanban"` |
| `src/config/runtime-config.ts` | 52 | `PROJECT_CONFIG_DIR` | `".kanban"` |

#### B2. Git Refs `refs/kanban/checkpoints/`

| File | Line | What |
|------|------|------|
| `src/workspace/turn-checkpoints.ts` | 29 | `refs/kanban/checkpoints/${taskId}/turn/${turn}` |
| `src/workspace/turn-checkpoints.ts` | 9-10 | Author: `kanban-checkpoint` / `kanban-checkpoint@local` |
| `src/workspace/turn-checkpoints.ts` | 58 | Commit message: `kanban checkpoint task:...` |

Old checkpoint refs in existing repos will become orphaned. Acceptable -- old checkpoints are low-value and can be cleaned up with `git for-each-ref --format='delete %(refname)' refs/kanban/ | git update-ref --stdin`.

#### B3. Git Exclude Block Markers

| File | Line | Marker |
|------|------|--------|
| `src/workspace/task-worktree.ts` | 17 | `# kanban-managed-symlinked-ignored-paths:start` |
| `src/workspace/task-worktree.ts` | 18 | `# kanban-managed-symlinked-ignored-paths:end` |

Old markers in `.git/info/exclude` will become inert (no longer matched by the parser). Harmless -- they're comments. New worktrees will get new markers.

#### B4. Environment Variables

| Variable | Used In |
|----------|---------|
| `KANBAN_RUNTIME_HOST` | `core/runtime-endpoint.ts` |
| `KANBAN_RUNTIME_PORT` | `core/runtime-endpoint.ts` |
| `KANBAN_STATE_HOME` | `state/workspace-state.ts` |
| `KANBAN_HOOK_TASK_ID` | `terminal/hook-runtime-context.ts` |
| `KANBAN_HOOK_WORKSPACE_ID` | `terminal/hook-runtime-context.ts` |
| `KANBAN_DEBUG_MODE` | `terminal/agent-registry.ts` |
| `KANBAN_TITLE_MODEL` | `title/title-generator.ts` |

Just rename to `QUARTERDECK_*`. Update shell profile if any are set.

#### B5. localStorage Keys

22 keys prefixed `kanban.` plus 1 key `kb-sidebar-width`. Clearing browser localStorage for the dev server origin resets everything cleanly. No migration code needed.

The `DetailPanelId` type uses `"kanban"` as a literal value stored in localStorage -- also just rename, the panel will reset to default on first load.

#### B6. `TERM_PROGRAM: "kanban"` and IPC

| File | Line | What |
|------|------|------|
| `src/terminal/session-manager.ts` | 200 | `TERM_PROGRAM: "kanban"` |
| `test/integration/shutdown-ipc-hook.cjs` | 6 | `kanban.shutdown` message type |

Just rename. No external consumers.

---

### C. KEEP AS-IS (Do Not Change)

#### C1. Fork Attribution

| File | Line | Reference | Why Keep |
|------|------|-----------|----------|
| `README.md` | 1 | `[kanban-org/kanban](https://github.com/kanban-org/kanban)` | Attribution to upstream -- required by Apache 2.0 |
| `CLAUDE.md` | 5 | `[kanban-org/kanban](https://github.com/kanban-org/kanban)` | Fork origin context |
| `docs/planned-features.md` | 150 | `[kanban-org/kanban]` | Historical reference to upstream |
| `LICENSE` | entire file | License text | Must not change per Apache 2.0 |

#### C2. Kanban as a Methodology/Concept

Some references use "kanban" to describe the board methodology, not the product name. These may or may not change depending on branding:

| File | Line | String | Recommendation |
|------|------|--------|---------------|
| `CLAUDE.md` | 3 | `"A CLI-based kanban board"` | Change to `"A CLI-based task board"` or `"Quarterdeck"` |
| `src/prompts/append-system-prompt.ts` | 70 | `"on a kanban board"` | Change to generic `"task board"` since the product is renamed |
| `CHANGELOG.md` | 385 | `"cards in the kanban column"` | Historical -- could leave as-is |
| `docs/architecture.md` | 137 | `"task worktrees are a Kanban concept"` | Change product name |

#### C3. CHANGELOG.md Historical Entries

The CHANGELOG records what happened in past versions. Rewriting history is generally bad practice. **Recommendation**: Leave old CHANGELOG entries as-is. Only update the header/title if it says "Kanban Changelog" and add a note that versions before X were released under the name "kanban".

#### C4. Upstream URLs Being Replaced (Not Kept)

These currently point to kanban-org and need to change to your new repo:

| File | Line | URL | Change To |
|------|------|-----|-----------|
| `package.json` | 16,18,23 | `github.com/kanban-org/kanban` | Your new repo URL |
| `README.md` | 17-33 | npm, GitHub, Issues, Feature Requests, Discord, Twitter links | Your new links |
| `.github/ISSUE_TEMPLATE/config.yml` | 4,7 | kanban-org discussions, discord.gg/kanban | Your new URLs |
| `runtime-settings-dialog.tsx` | 820 | `github.com/kanban-org/kanban` | Your new repo URL |
| `docs/plans/*.md` | ~419 | `github.com/kanban-org/kanban/issues` | Your new repo URL |

---

### D. CSS `kb-` Prefix Audit

**Scope**: ~80 distinct class names, 151 lines in `globals.css`, 157 usages across 30 component files, plus 1 DOM element ID (`kb-persistent-terminal-parking-root`).

**Should it change?** This is purely internal CSS. There is zero external API surface. Options:
1. **Change to `qd-`**: Consistent branding but ~310 line changes for zero functional benefit. High churn, risk of missing a reference.
2. **Keep `kb-`**: No migration concern, no functional impact. The prefix is short and memorable. "kb" could stand for "keyboard" or nothing at all.
3. **Change later**: Defer to a separate PR to reduce scope of the rename PR.

**Recommendation**: Keep `kb-` for now. It's purely internal and the rename PR is already large enough.

---

## Execution Plan

### Step 1: Codebase Rename (One Atomic Commit)
1. Rename `man/kanban.1` -> `man/quarterdeck.1` (git mv)
2. Rename 4 web-ui files containing "kanban" in filename (git mv)
3. Rename `src/core/kanban-command.ts` -> `src/core/quarterdeck-command.ts` (git mv)
4. Rename `test/runtime/kanban-command.test.ts` -> `test/runtime/quarterdeck-command.test.ts` (git mv)
5. Update `package.json` -- name, bin, man, repo, homepage, bugs, author, description, keywords, unlink script
6. Update `web-ui/package.json` -- name
7. Global find-and-replace across all source, tests, docs (see substitution table below)
8. Update CI/CD workflows
9. Update README with new links (replace kanban-org URLs with your repo)
10. Update CLAUDE.md, AGENTS.md, DEVELOPMENT.md
11. `rm -rf node_modules web-ui/node_modules package-lock.json web-ui/package-lock.json && npm run install:all` to regenerate lockfiles
12. Run `npm run check && npm run build` to verify nothing broke

### Step 2: External Setup
1. Create new GitHub repo (e.g. `d.cole/quarterdeck`)
2. `git remote set-url origin <new-repo-url>`
3. Push

### Substitution Table

Apply these in order (most specific first to avoid partial matches):

| Find | Replace | Scope |
|------|---------|-------|
| `kanban-org/kanban` | Your new GitHub org/repo (in URLs) -- **except** the fork attribution line in README.md and CLAUDE.md | URLs only |
| `@kanban/web` | `@quarterdeck/web` | package.json names |
| `kanban-managed-symlinked-ignored-paths` | `quarterdeck-managed-symlinked-ignored-paths` | git exclude markers |
| `kanban-task-worktree-setup` | `quarterdeck-task-worktree-setup` | lockfile name |
| `kanban-checkpoint` | `quarterdeck-checkpoint` | git checkpoint author/email/message |
| `kanban-codex-session` | `quarterdeck-codex-session` | temp file prefix |
| `kanban-selective-build-minify` | `quarterdeck-selective-build-minify` | vite plugin |
| `__kanban_createRequire` | `__quarterdeck_createRequire` | build shim |
| `__kanbanUpgradeHandled` | `__quarterdeckUpgradeHandled` | internal property |
| `__kanbanOpencodePluginV3` | `__quarterdeckOpencodePluginV3` | globalThis guard |
| `x-kanban-workspace-id` | `x-quarterdeck-workspace-id` | HTTP header |
| `kanban.shutdown` | `quarterdeck.shutdown` | IPC message type |
| `KANBAN_RUNTIME_HOME_DIR_NAME` | `QUARTERDECK_RUNTIME_HOME_DIR_NAME` | const names |
| `KANBAN_TASK_WORKTREES_HOME_DIR_NAME` | `QUARTERDECK_TASK_WORKTREES_HOME_DIR_NAME` | const names |
| `KANBAN_TASK_WORKTREES_DIR_NAME` | `QUARTERDECK_TASK_WORKTREES_DIR_NAME` | const names |
| `KANBAN_TASK_WORKTREES_DISPLAY_ROOT` | `QUARTERDECK_TASK_WORKTREES_DISPLAY_ROOT` | const names |
| `KANBAN_HOOK_TASK_ID` | `QUARTERDECK_HOOK_TASK_ID` | env var name + const |
| `KANBAN_HOOK_WORKSPACE_ID` | `QUARTERDECK_HOOK_WORKSPACE_ID` | env var name + const |
| `KANBAN_RUNTIME_HOST` | `QUARTERDECK_RUNTIME_HOST` | env var name + const |
| `KANBAN_RUNTIME_PORT` | `QUARTERDECK_RUNTIME_PORT` | env var name + const |
| `KANBAN_STATE_HOME` | `QUARTERDECK_STATE_HOME` | env var name |
| `KANBAN_DEBUG_MODE` | `QUARTERDECK_DEBUG_MODE` | env var name |
| `KANBAN_TITLE_MODEL` | `QUARTERDECK_TITLE_MODEL` | env var name |
| `KANBAN_VERSION` | `QUARTERDECK_VERSION` | const name |
| `KanbanPlugin` | `QuarterdeckPlugin` | OpenCode plugin export |
| `KanbanBoard` | `QuarterdeckBoard` | React component |
| `KanbanAccessBlockedFallback` | `QuarterdeckAccessBlockedFallback` | React component |
| `useKanbanAccessGate` | `useQuarterdeckAccessGate` | React hook |
| `UseKanbanAccessGateInput` | `UseQuarterdeckAccessGateInput` | TypeScript interface |
| `createKanbanTerminalOptions` | `createQuarterdeckTerminalOptions` | function name |
| `CreateKanbanTerminalOptionsInput` | `CreateQuarterdeckTerminalOptionsInput` | TypeScript interface |
| `hasVisibleKanbanTabForWorkspace` | `hasVisibleQuarterdeckTabForWorkspace` | function name |
| `isKanbanAccessBlocked` | `isQuarterdeckAccessBlocked` | variable name |
| `buildKanbanRuntimeUrl` | `buildQuarterdeckRuntimeUrl` | function name |
| `buildKanbanRuntimeWsUrl` | `buildQuarterdeckRuntimeWsUrl` | function name |
| `getKanbanRuntimeHost` | `getQuarterdeckRuntimeHost` | function name |
| `setKanbanRuntimeHost` | `setQuarterdeckRuntimeHost` | function name |
| `getKanbanRuntimePort` | `getQuarterdeckRuntimePort` | function name |
| `setKanbanRuntimePort` | `setQuarterdeckRuntimePort` | function name |
| `getKanbanRuntimeOrigin` | `getQuarterdeckRuntimeOrigin` | function name |
| `getKanbanRuntimeWsOrigin` | `getQuarterdeckRuntimeWsOrigin` | function name |
| `DEFAULT_KANBAN_RUNTIME_HOST` | `DEFAULT_QUARTERDECK_RUNTIME_HOST` | const name |
| `DEFAULT_KANBAN_RUNTIME_PORT` | `DEFAULT_QUARTERDECK_RUNTIME_PORT` | const name |
| `buildKanbanCommandParts` | `buildQuarterdeckCommandParts` | function name |
| `resolveKanbanCommandParts` | `resolveQuarterdeckCommandParts` | function name |
| `canReachKanbanServer` | `canReachQuarterdeckServer` | function name |
| `spawnDetachedKanban` | `spawnDetachedQuarterdeck` | function name |
| `setKanbanProcessContext` | `setQuarterdeckProcessContext` | test helper |
| `startKanbanServer` | `startQuarterdeckServer` | test helper |
| `refs/kanban/` | `refs/quarterdeck/` | git ref prefix |
| `".kanban"` | `".quarterdeck"` | directory name strings |
| `.kanban/` | `.quarterdeck/` | path fragments in strings/docs |
| `kanban.` (localStorage prefix) | `quarterdeck.` | localStorage key values |
| `"kanban"` (DetailPanelId) | `"board"` | panel ID literal (better name than "quarterdeck" for a panel) |
| `TERM_PROGRAM: "kanban"` | `TERM_PROGRAM: "quarterdeck"` | child process env |
| `name("kanban")` | `name("quarterdeck")` | Commander.js CLI name |
| `name = "kanban"` | `name = "quarterdeck"` | .codex environment |
| `"kanban": "dist/cli.js"` | `"quarterdeck": "dist/cli.js"` | package.json bin |
| `kanban` -> `quarterdeck` | In user-facing strings, prompts, docs, man page | Case-sensitive: preserve `Kanban` -> `Quarterdeck` and `kanban` -> `quarterdeck` |

**Do NOT change**:
- Fork attribution URLs (`kanban-org/kanban`) in README.md line 1 and CLAUDE.md line 5
- LICENSE file
- CHANGELOG.md historical entries (add a note at the top instead)
- `kb-` CSS class prefix (keep as-is, purely internal)
- `kb-sidebar-width` localStorage key (keep, or rename -- low impact)
- `kb-persistent-terminal-parking-root` DOM ID (keep)

## High-Churn Files (Most References)

- `src/prompts/append-system-prompt.ts` -- ~40 references (system prompt text)
- `src/core/runtime-endpoint.ts` -- ~20 references (function names)
- `src/cli.ts` -- ~30 references
- `test/integration/runtime-state-stream.integration.test.ts` -- ~40 references
- `web-ui/src/styles/globals.css` -- 151 lines with `kb-` prefix (NOT changing)

## Open Questions

1. **Should `kb-` CSS prefix change?** Recommendation: No, keep permanently. See Section D.
2. **Should CHANGELOG.md historical entries be rewritten?** Recommendation: No, add a note at the top.
3. **npm scope**: Publish as `quarterdeck` or `@dcole/quarterdeck`? Scoped avoids name conflicts.
4. **Discord/Twitter**: The README links to `discord.gg/kanban` and `x.com/kanban` -- these are upstream's. Remove or replace with your own.
5. **`@/kanban/utils/react-use`** import path in AGENTS.md -- appears only in AGENTS.md, not in actual code. May be a suggested convention that was never implemented. Rename to `@/quarterdeck/utils/react-use` or verify and remove.

---

## Local Migration Guide

Run these **after** the codebase rename commit, **before** launching quarterdeck.

```bash
# 1. Move global state
mv ~/.kanban ~/.quarterdeck

# 2. Move per-project config dirs
find ~/Desktop/Projects -maxdepth 2 -type d -name ".kanban" -exec sh -c 'mv "$1" "$(dirname "$1")/.quarterdeck"' _ {} \;

# 3. Clear browser localStorage (panel sizes, prefs — will be recreated)
#    Open DevTools on http://127.0.0.1:4173 → Application → Local Storage → Clear All

# 4. Re-link the CLI
cd /path/to/quarterdeck
npm run link
which quarterdeck && quarterdeck --version
```

That's it. Old git refs (`refs/kanban/checkpoints/...`) and git exclude markers become inert but are harmless — no cleanup needed.
