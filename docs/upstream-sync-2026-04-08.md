# Upstream Sync Review: cline/kanban

**Date:** 2026-04-08
**Fork point:** `255e940d` — `fix: update feedback button test to match renamed label` (2026-04-04)
**Upstream repo:** [cline/kanban](https://github.com/cline/kanban)
**Upstream commits since fork:** 10
**Quarterdeck commits since fork:** 205

---

## Summary

Quarterdeck forked from cline/kanban at commit `255e940d` on 2026-04-04. Since then, the upstream has landed 10 commits while Quarterdeck has diverged significantly with 205 commits. Several upstream changes touch Cline-specific SDK code (`src/cline-sdk/`) that Quarterdeck removed entirely, making those commits irrelevant. A few commits touch shared infrastructure that may be worth cherry-picking or reimplementing.

---

## Upstream Commits

### 1. Skip unnecessary Cline session-host probe on Codex trash restore (#235)
- **Hash:** `2875041c` | **Author:** Ara | **Date:** 2026-04-06
- **Files:** `src/trpc/runtime-api.ts`, `test/runtime/trpc/runtime-api.test.ts`
- **What:** Prevents an unnecessary Cline session-host probe when restoring a Codex task from trash. Adds tests.
- **Incorporate?** **No.** Quarterdeck doesn't have `src/cline-sdk/` and has heavily rewritten `runtime-api.ts` (+796 lines of diff since fork). This is Cline-specific session management that doesn't apply to our multi-agent architecture.

### 2. feat: add 10 color themes with compact settings picker (#236)
- **Hash:** `2b80698d` | **Author:** Ara | **Date:** 2026-04-06
- **Files:** 15 files — `use-theme.ts` (new), `globals.css`, `runtime-settings-dialog.tsx`, `App.tsx`, terminal theme integration, etc.
- **What:** Adds 10 color themes (dark variants) with a compact picker in the settings dialog. Themes propagate to terminals via xterm theme colors. Persisted in localStorage.
- **Incorporate?** **Maybe — as inspiration.** Quarterdeck has its own dark-only theme with design tokens in `globals.css`. Our settings dialog has already diverged heavily (+843 lines). A theming system could be nice but would need to be reimplemented against our token system rather than cherry-picked. Low priority — our single dark theme works well.

### 3. allow https flags for kanban and passcode auth (#204)
- **Hash:** `7d57f04c` | **Author:** Max | **Date:** 2026-04-06
- **Files:** 15 files — `cli.ts`, `runtime-endpoint.ts`, `runtime-server.ts`, new `passcode-manager.ts`, `passcode-gate.tsx`, etc.
- **What:** Adds `--https` and `--passcode` CLI flags for secure remote access. Generates self-signed TLS certs, adds passcode authentication gate in the UI, updates the service worker for HTTPS. Big change (~1560 lines added).
- **Incorporate?** **Yes — worth evaluating seriously.** Quarterdeck already runs over SSH tunnels on headless instances. Native HTTPS + passcode auth would be a cleaner alternative. However, this is a large change and our `cli.ts`, `runtime-server.ts`, and `runtime-endpoint.ts` have all diverged significantly. Would need to be reimplemented rather than cherry-picked. Consider this for a future security/remote-access milestone.

### 4. feat: add dev:full script and VS Code launch config for full-stack dev (#212)
- **Hash:** `2890e1a5` | **Author:** Robin Newhouse | **Date:** 2026-04-06
- **Files:** `.vscode/launch.json`, `DEVELOPMENT.md`, `package.json`, `scripts/dev-full.mjs`, `web-ui/vite.config.ts`
- **What:** Adds a `dev:full` npm script that starts both the runtime server and web UI dev server in a single command. Updates VS Code launch config.
- **Incorporate?** **Maybe.** We already have separate `npm run dev` and `npm run web:dev` commands and a working launch.json. A combined script could be convenient but isn't critical. Low priority — our two-terminal workflow is documented and works.

### 5. feat: show friendly labels for kanban task commands in sidebar chat (#216)
- **Hash:** `577009f4` | **Author:** Robin Newhouse | **Date:** 2026-04-06
- **Files:** `src/cline-sdk/cline-tool-call-display.ts` (new), `cline-chat-message-item.tsx`, `cline-chat-message-utils.ts/.test.ts`
- **What:** Shows human-friendly labels for Cline task tool calls in the sidebar chat panel instead of raw JSON.
- **Incorporate?** **No.** Entirely within `src/cline-sdk/` which Quarterdeck doesn't have. Cline-specific sidebar chat integration.

### 6. style: mute beta hint card in project sidebar
- **Hash:** `b7e81f15` | **Author:** Saoud Rizwan | **Date:** 2026-04-06
- **Files:** `web-ui/src/components/project-navigation-panel.tsx`
- **What:** Minor styling tweak — mutes the beta hint card's visual prominence in the project sidebar.
- **Incorporate?** **No.** Trivial styling change on a component we've already modified. Not relevant.

### 7. fix: support browser back from detail view
- **Hash:** `7285af36` | **Author:** Saoud Rizwan | **Date:** 2026-04-06
- **Files:** `App.tsx`, new `app-utils.tsx`, new `use-detail-task-navigation.ts/.test.tsx`
- **What:** Adds browser history integration so the back button works when navigating into/out of the task detail view. Creates a new navigation hook with URL hash-based routing.
- **Incorporate?** **Maybe — the concept is good.** Browser back/forward for detail views is a real UX gap. However, our `App.tsx` has diverged massively (+818 lines) and we don't have the same detail view navigation model. The _idea_ is worth stealing; the code would need reimplementation.

### 8. fix: reinitialize task chat state on trash resume
- **Hash:** `83f750b7` | **Author:** Saoud Rizwan | **Date:** 2026-04-06
- **Files:** `src/cline-sdk/cline-task-session-service.ts`, `src/trpc/runtime-api.ts`, tests
- **What:** When a task is restored from trash, reinitializes the Cline chat session state so the sidebar chat works correctly.
- **Incorporate?** **No.** Cline SDK specific. We handle trash restore differently and don't have Cline chat sessions.

### 9. feat(diff-viewer): add incremental expand to collapsed context blocks (#247)
- **Hash:** `56adf45a` | **Author:** Max | **Date:** 2026-04-07
- **Files:** `diff-viewer-panel.tsx`, `diff-renderer.tsx/.test.ts`
- **What:** Adds "show 20 more lines" incremental expand buttons to collapsed context blocks in the diff viewer. Replaces full-expand with progressive expansion.
- **Incorporate?** **Yes — strong candidate.** We have `diff-renderer.tsx` and it's a shared concern. Our diff viewer would benefit from incremental expand. Need to check how far our `diff-renderer.tsx` has diverged — if it's still structurally similar, a cherry-pick or targeted merge might work. If not, reimplement the feature against our version.

### 10. fix: handle nullable fetchRemoteConfig in SDK boundary (#264)
- **Hash:** `e9a8f1b5` | **Author:** John Choi | **Date:** 2026-04-07
- **Files:** `src/cline-sdk/cline-provider-service.ts`, `src/cline-sdk/sdk-provider-boundary.ts`
- **What:** Null-safety fix for `fetchRemoteConfig` in the Cline SDK boundary layer.
- **Incorporate?** **No.** Cline SDK specific. We don't have this code.

---

## Recommendations

### Worth incorporating (reimplement)
| Commit | Feature | Priority | Effort |
|--------|---------|----------|--------|
| `56adf45a` | Incremental diff expand | Medium | Low-Med |

### Worth considering (inspiration only)
| Commit | Feature | Priority | Notes |
|--------|---------|----------|-------|
| `7d57f04c` | HTTPS + passcode auth | Low | Alternative to SSH tunnels for remote access — not needed if SSH tunneling works |
| `2b80698d` | Color themes | Low | Nice-to-have, reimpl against our tokens |
| `7285af36` | Browser back/forward nav | Low | Good UX, needs full reimplementation |
| `2890e1a5` | Combined dev script | Low | Convenience only |

### Not applicable (Cline-specific or trivial)
`2875041c`, `577009f4`, `b7e81f15`, `83f750b7`, `e9a8f1b5` — all touch Cline SDK code or are trivial styling changes that don't apply.

---

## Notes on future syncing

With 205 commits of divergence and the removal of the entire `cline-sdk/` layer, cherry-picking from upstream is unlikely to work cleanly for any non-trivial change. The practical approach going forward is:
1. **Monitor upstream** periodically for feature ideas
2. **Reimplement** rather than merge — our architecture has diverged too far
3. **Focus on the diff viewer** as the most directly portable upstream improvement
