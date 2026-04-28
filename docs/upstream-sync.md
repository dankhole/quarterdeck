# Upstream Sync Tracker

Quarterdeck forked from [cline/kanban](https://github.com/cline/kanban) at commit `255e940d` on 2026-04-04. The two projects have diverged significantly — Quarterdeck removed the entire `cline-sdk/` layer, added multi-agent support, and has 200+ commits of its own. Cherry-picking from upstream rarely works cleanly; the practical approach is to monitor upstream for feature ideas and reimplement against our architecture.

This is a living document. Each upstream review updates the sections below rather than creating a new file. See todo.md for the recurring review cadence.

**Last checked:** 2026-04-10 — upstream commit `2c68b039` (22 commits reviewed since fork)

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

---

## Backlog

Worth doing eventually. Ordered roughly by value.

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
`2875041c` (skip Cline session-host probe on Codex trash restore), `577009f4` (friendly labels for Cline task tool calls in sidebar chat), `e9a8f1b5` (nullable fetchRemoteConfig in SDK boundary), `95f2edaf` (stream clear semantics in Cline message repository), `9398a457` (read-only startup — removed locally), `83f750b7` (trash resume — adopted concept, not code)

All touch `src/cline-sdk/` code or Cline-specific session management. Quarterdeck removed the entire Cline SDK layer and uses its own multi-agent architecture with per-agent adapters. Structurally inapplicable.

### Cline account / billing / organization
`41776b75` (account org switching + credit balance display, 14 files), `c506dd64` (credit limit SDK-native handling + board-level credit banner, 10 files), `cd557b7b` (account settings layout polish, 5 files)

Cline-platform billing and account infrastructure. Quarterdeck doesn't use Cline accounts or have any billing concept. Not applicable. One minor note: `c506dd64` introduced a reusable `Link` UI component (`web-ui/src/components/ui/link.tsx`, 26 lines) — a styled anchor with external link support. Worth borrowing if we ever need one, but no immediate need.

### Cline onboarding dialog fix (`2c68b039`)
Simplifies the startup onboarding dialog to never reopen after first close (previously it would reopen if agent wasn't authenticated). Quarterdeck has its own `StartupOnboardingDialog` with different logic. The upstream fix is specific to Cline authentication state checks that don't exist in our version.

### Color themes (`2b80698d`, `10a359e4`)
`2b80698d`: 10 color themes (dark variants) with compact picker in settings dialog, persisted in localStorage, propagated to terminals via xterm theme colors. 15 files, new `use-theme.ts` hook with `ThemeDefinition` type.
`10a359e4`: Follow-up — flat swatch styling (replacing 3D radial gradients) and hue-ordered reordering.

Quarterdeck doesn't have a theme system — single dark theme with design tokens in `globals.css`. A theming system could be nice eventually but would need full reimplementation against our token system. The upstream theme definitions and picker UI aren't portable since our settings dialog has diverged heavily (+843 lines).

### Beta hint card styling (`b7e81f15`)
Trivial styling tweak — mutes the beta hint card in the project sidebar. We don't have this component. Not relevant.

---

## Notes on syncing methodology

With 200+ commits of divergence and the removal of the entire `cline-sdk/` layer:
1. **Monitor upstream** periodically for feature ideas — see todo.md for cadence
2. **Reimplement** rather than merge — architecture has diverged too far for clean cherry-picks on anything non-trivial
3. **Update this doc** after each review — move items between sections as they're adopted or rejected
4. Roughly half of upstream's output is Cline SDK/account work that will never apply to Quarterdeck. The other half is shared UI/UX work where the ideas are portable even if the code isn't.
