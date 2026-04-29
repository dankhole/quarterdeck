# Upstream Sync Tracker

Quarterdeck forked from [cline/kanban](https://github.com/cline/kanban) at commit `255e940d` on 2026-04-04. The two projects have diverged significantly — Quarterdeck removed the entire `cline-sdk/` layer, added multi-agent support, and has 200+ commits of its own. Cherry-picking from upstream rarely works cleanly; the practical approach is to monitor upstream for feature ideas and reimplement against our architecture.

This is a living document. Each upstream review updates the sections below rather than creating a new file. See todo.md for the recurring review cadence.

**Last checked:** 2026-04-29 — upstream commit `e8976aeef` (68 commits reviewed since `2c68b039`)

---

## Latest Review Summary

The 2026-04-29 review found a few portable ideas, but no clean cherry-pick candidates. Reimplemented from that review:

- Runtime request hardening: HTTP/WebSocket host and origin allowlists (`c54b7669e`).
- Small launch/identity hardening: disable Codex startup update checks for Quarterdeck-launched sessions (`4cb3f4fc3`) and remove timestamp-derived fallback task IDs (`f0c44311c`).

Best remaining product ideas:

- Remote project directory browsing / clone flow (`6cdc8fe40`), Kiro CLI agent support (`52d9d6cfd`), and task-scoped agent/model selection (`a2e4dcf19`).

Most other commits were Cline SDK/account/model-catalog work, WorkOS auth, release notes, desktop packaging, or reverted UI experiments.

---

## Adopted

Features we pulled from upstream, or arrived at independently before upstream shipped them.

| Upstream commit | Feature | Status | Details |
|-----------------|---------|--------|---------|
| `56adf45a` | Incremental diff expand ("show 20 more lines") | Cherry-picked 2026-04-08 | Adapted into `useIncrementalExpand` hook + `CollapsedBlockControls` component. See implementation log. |
| `a57bf913` | Editable task titles + title in create/edit dialogs | Already had | Upstream inlines all editing state in `board-card.tsx`. Quarterdeck has a cleaner separation: extracted `InlineTitleEditor` component, `use-title-actions.ts` hook, `task_title_updated` WebSocket sync. Upstream also added `src/core/task-title.ts` with `resolveTaskTitle()` / `deriveTaskTitleFromPrompt()` (server-side title derivation from first sentence of prompt) — we don't have that but our client-side `truncateTaskPromptLabel` serves the same display purpose. |
| `201ce48b` | Diff mode toggle active state fix | Already had | Upstream fixed `cn()` conditional not applying active styles on "All Changes" / "Last Turn" buttons by switching to inline `style` with CSS vars. Our `DiffModeSelector` in `card-detail-view.tsx:131-148` already uses the inline style approach. Same fix, arrived at independently. |
| `9398a457` | Read-only startup via prompt injection instead of SDK mode | Removed 2026-04-28 | Quarterdeck previously had a similar startup-only task flag, but that product path and adapter startup behavior were removed. |
| `83f750b7` | Reinitialize session state on trash restore | Already had | Upstream reinitializes Cline chat session state when restoring from trash. Quarterdeck's `handleRestoreTaskFromTrash` in `use-board-interactions.ts` calls `ensureTaskWorkspace()` + `startTaskSession({ resumeConversation: true, awaitReview: true })` — same concept, different architecture. |
| `7285af36` | Browser back/forward for task detail view | Reimplemented 2026-04-10 | New `use-detail-task-navigation.ts` hook. URL search param `?task=<id>` with `pushState` on open, `popstate` on back. Replaces raw `useState` for `selectedTaskId` in `App.tsx`. |
| `e8b39314`, `c06663c1` | Onboarding tips in sidebar | Reimplemented 2026-04-10 | `OnboardingTips` component in `project-navigation-panel.tsx`. Quarterdeck-specific tips (create tasks, parallel agents, review changes). localStorage dismiss/restore via `OnboardingTipsDismissed` key. |
| `2890e1a5` | Combined dev:full script | Reimplemented 2026-04-10 | `scripts/dev-full.mjs` spawns both runtime and web UI dev servers with prefixed output. `npm run dev:full` in `package.json`. |
| `bba1156e6` | Preserve task detail view on refresh | Already had | Quarterdeck's `use-detail-task-navigation` initializes from `?task=<id>` and delays missing-card cleanup until `isBoardHydrated`, so a refreshed task-detail URL survives the initial empty-board render. |
| `142cbc8e5`, `69b070c18` | Hover pencil title editing + no live create-title preview | Already had | `BoardCard` shows a hover pencil wired to `InlineTitleEditor`, and create/edit surfaces do not render upstream's live title preview path. The inline editor stops card click-through while preserving native input cursor behavior. |
| `c54b7669e` | Runtime Host/Origin allowlist | Reimplemented 2026-04-29 | `src/server/middleware.ts` now gates HTTP requests plus runtime-state and terminal WebSocket upgrades by known Host/Origin values. Development Vite and e2e proxy origins stay explicit through `NODE_ENV=development` and configured web UI ports. |
| `4cb3f4fc3` | Disable Codex startup update checks | Reimplemented 2026-04-29 | Codex launches now add `-c check_for_update_on_startup=false` unless the user already supplied that Codex config override. |
| `f0c44311c` | Timestamp-free fallback task IDs | Reimplemented 2026-04-29 | Runtime and browser fallback task ID generation no longer mixes `Date.now()` into the UUID-unavailable fallback path. |

---

## Backlog

Worth doing eventually. Ordered roughly by value.

### Remote project browser and clone flow (`6cdc8fe40`)
**Upstream:** Adds a remote directory browser, path autocomplete, server-side directory listing, and clone-by-Git-URL support from the add-project dialog.
**Our current state:** Quarterdeck has native folder picker support plus manual path-entry fallback for headless Linux, but no server-side browser or clone flow.
**Why it matters:** This would materially improve remote/headless setup over SSH tunnels, where native folder pickers may not exist.
**Action:** Worth a separate design pass. The upstream sandbox is rooted at server cwd and would need rethinking for Quarterdeck's project registry, state home, and security model.

### Kiro CLI agent support (`52d9d6cfd`)
**Upstream:** Adds `kiro-cli chat` as a task agent with a Kiro-specific hook adapter and metadata normalizer.
**Our current state:** Quarterdeck supports Claude, Codex, and Pi. Adding a new task agent touches `runtimeAgentIdSchema`, the catalog, availability probing, launch adapters, hook metadata, settings/onboarding UI, and tests.
**Why it matters:** Kiro is a plausible additional agent in the same multi-agent architecture, but only if its hook/resume behavior is reliable enough for Quarterdeck's session-state invariants.
**Action:** Reassess when there is actual Kiro user demand. Treat upstream as a reference for hook payload shape, not as portable code.

### Task-scoped agent/model selection (`a2e4dcf19`)
**Upstream:** Adds per-task Cline provider/model override UI and persistence.
**Our current state:** Quarterdeck now chooses the harness from the new task dialog, persists the selected harness per task, shows the effective harness on task cards, and preserves the previous session's harness on resume/restart.
**Why it matters:** Mixed-harness boards are now supported at the task level. Provider/model-specific controls should build on that task harness contract instead of replacing it.
**Action:** Treat upstream as validation for task-scoped runner choice, not as portable code. Do not port the Cline model picker directly unless Quarterdeck adds harness-specific model/provider settings later.

### Settings sidebar navigation (`be6ec58f7`, `148d4d5af`)
**Upstream:** Experiments with a multi-panel settings dialog and then consolidates into a sidebar-navigation layout.
**Our current state:** Quarterdeck's settings dialog is already split into section components, but still uses one long scroll body.
**Why it matters:** Sidebar navigation could help as settings continue to grow, but it is lower priority than runtime/security and task-agent work.
**Action:** Keep as a UX idea for a settings refresh. Avoid copying upstream's final one-file consolidation; Quarterdeck should preserve its existing section modules.

### Update-available modal (`e8976aeef`)
**Upstream:** Adds a "new version available" modal with one-click update.
**Our current state:** Quarterdeck is not published to npm yet; `docs/todo.md` still tracks the first npm publish.
**Why it matters:** Useful after a real distribution channel exists.
**Action:** Revisit after npm publishing. Upstream's UI flow is useful conceptually, but the update command and package identity need Quarterdeck-specific design.

### Mobile / responsive foundations (`ff0ff810`)
**Upstream:** Comprehensive mobile view (+1155/-550 lines, 22 files) — hamburger menu, tab bar, slide-up sheets, scroll-snap columns. New `useIsMobile()` hook (768px breakpoint via `useMedia`).
**What's portable:** The full layout is too entangled with Cline components, but several pieces are independently useful:
- `useMedia` wrapper for `react-use.ts` barrel (4 lines)
- `useIsMobile` hook (768px breakpoint, 7 lines)
- Dialog touch-safety: `touch-none` on overlays, `overscroll-contain` on bodies
- CSS responsive guards: `@media (hover: hover)` for hover states, Safari auto-zoom prevention (`font-size: 16px !important` on inputs), `scroll-snap-type: x mandatory` for board columns
- Extracted `kb-dialog-content` CSS animation class (moves dialog animation from inline style to stylesheet)

**Action:** Adopt the small utilities and CSS patterns first. Full mobile layout is a separate initiative.

### HTTPS + passcode auth (`7d57f04c`)
**Upstream:** `--https` and `--passcode` CLI flags for secure remote access (~1560 lines, 15 files). Generates self-signed TLS certs via new `passcode-manager.ts`, adds passcode auth gate in UI (`passcode-gate.tsx`), updates service worker for HTTPS.
**Our current state:** Quarterdeck runs over SSH tunnels on headless instances. No native HTTPS or auth.
**Why it matters:** Cleaner alternative to SSH tunnels for remote access. Important for eventual public release.
**Action:** Evaluate when doing a security/remote-access milestone. Would need full reimplementation — `cli.ts`, `runtime-server.ts`, and `runtime-endpoint.ts` have all diverged heavily.

---

## Decided against

Features we evaluated and won't adopt, with reasoning.

### Cline SDK / session management
`2875041c` (skip Cline session-host probe on Codex trash restore), `577009f4` (friendly labels for Cline task tool calls in sidebar chat), `e9a8f1b5` (nullable fetchRemoteConfig in SDK boundary), `95f2edaf` (stream clear semantics in Cline message repository), `9398a457` (read-only startup — removed locally), `83f750b7` (trash resume — adopted concept, not code), `aa72d4de`, `d4f4ab21e`, `559965c70`, `e8a136278`, `58942a80d`, `9b5ea1d3c` (SDK version bumps / integration updates), `21171220d`, `a69dbf7c8`, `c5b95a541`, `7d742c50a` (SDK MCP registration/settings visibility churn), `d913630a5`, `5638cfa25`, `8c61a36e6`, `b52dba9df`, `92e3b556e`, `044734479`, `a36bc192b` (Cline home chat / thinking / provider/session behavior)

All touch `src/cline-sdk/` code or Cline-specific session management. Quarterdeck removed the entire Cline SDK layer and uses its own multi-agent architecture with per-agent adapters. Structurally inapplicable.

### Cline account / billing / organization
`41776b75` (account org switching + credit balance display, 14 files), `c506dd64` (credit limit SDK-native handling + board-level credit banner, 10 files), `cd557b7b` (account settings layout polish, 5 files), `e61b4e690` (WorkOS device authorization)

Cline-platform billing and account infrastructure. Quarterdeck doesn't use Cline accounts or have any billing concept. Not applicable. One minor note: `c506dd64` introduced a reusable `Link` UI component (`web-ui/src/components/ui/link.tsx`, 26 lines) — a styled anchor with external link support. Worth borrowing if we ever need one, but no immediate need.

### Cline onboarding dialog fix (`2c68b039`)
Simplifies the startup onboarding dialog to never reopen after first close (previously it would reopen if agent wasn't authenticated). Quarterdeck has its own `StartupOnboardingDialog` with different logic. The upstream fix is specific to Cline authentication state checks that don't exist in our version.

### Color themes (`2b80698d`, `10a359e4`)
`2b80698d`: 10 color themes (dark variants) with compact picker in settings dialog, persisted in localStorage, propagated to terminals via xterm theme colors. 15 files, new `use-theme.ts` hook with `ThemeDefinition` type.
`10a359e4`: Follow-up — flat swatch styling (replacing 3D radial gradients) and hue-ordered reordering.
`2c8dc3810`, `e8806a69d`, `17a801c29`: Newer theme-picker and contrast follow-ups.

Quarterdeck doesn't have a theme system — single dark theme with design tokens in `globals.css`. A theming system could be nice eventually but would need full reimplementation against our token system. The upstream theme definitions and picker UI aren't portable since our settings dialog has diverged heavily (+843 lines).

### Beta hint card styling (`b7e81f15`)
Trivial styling tweak — mutes the beta hint card in the project sidebar. We don't have this component. Not relevant.

### Reverted diff experiments (`005ebb7ac`, `4a6422a20`, `55f564a5c`, `903b9500b`)
Upstream added a file-tree toggle for diff views and multi-line comments, then reverted both. No action.

### Desktop packaging (`fa267422f`, `c6720c379`, `30980f646`)
The desktop workspace and runtime child process manager are a separate product direction. Quarterdeck remains a CLI-served web app for now, so this is not an upstream-sync adoption target unless the product direction changes.

### Cline model catalog and provider polish (`1ee1a1f67`, `e22e1ade2`, `659e5031c`, `3d7016738`, `09ebc20be`, `01037d591`, `5e55976e5`, `8a1468737`)
Cline provider/model-catalog maintenance, plus `7ccde0648` (jsdom guard in the Cline model selector). Quarterdeck's agent selection and lightweight LLM helper config are separate systems; do not port this directly.

### Minor upstream-only UI/dev/test fixes (`0bc562c51`, `940132371`, `aed656f19`, `bcd955ae2`)
Hook notify process cleanup, agent tips styling, `dev-full` shutdown-cleanup defaults/bootstrap behavior, and a task-card layout-shift rewrite. Quarterdeck's hook path, dev scripts, onboarding tips, and board-card layout have diverged enough that these are not portable. Revisit only if the same local symptom appears.

### Release notes, dependency, and branding churn
`fbade8fe2`, `3f7b14061`, `e3f03dc53`, `8d7b5fc9a`, `861c8a095`, `023e2eede`, `50cf9835e`, `1059203a9`, `cd86dbcf7`, `6ab59c5d4`, `1b69cd8b1`, `9e94d7bc1`, `14b3d0daa`, `d8b1605b0`, `264053393`

Release-note updates, lockfile/dependency churn, upstream branding fallback, Node-version bump, and a repo-local Kanban shortcut. No Quarterdeck action.

---

## Notes on syncing methodology

With 200+ commits of divergence and the removal of the entire `cline-sdk/` layer:
1. **Monitor upstream** periodically for feature ideas — see todo.md for cadence
2. **Reimplement** rather than merge — architecture has diverged too far for clean cherry-picks on anything non-trivial
3. **Update this doc** after each review — move items between sections as they're adopted or rejected
4. Roughly half of upstream's output is Cline SDK/account work that will never apply to Quarterdeck. The other half is shared UI/UX work where the ideas are portable even if the code isn't.
