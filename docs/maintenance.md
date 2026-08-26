# Repository Maintenance

Recurring maintenance belongs here rather than in the active product backlog.

## Upstream review

Review the diverged [`cline/kanban`](https://github.com/cline/kanban) upstream periodically when active development makes a review useful. Use [`upstream-sync.md`](./upstream-sync.md) as the living Adopted / Backlog / Decided-against record and update its last-checked commit and date after each pass.

Quarterdeck has diverged substantially and removed the Cline SDK/account layer, so evaluate ideas first and expect reimplementation rather than direct cherry-picks. Do not preserve a calendar cadence when there is no actionable upstream activity.

## Documentation lifecycle

During documentation-heavy or release cleanup:

- keep stable architecture, conventions, testing, and operator references in the active docs map;
- keep only actionable work in [`todo.md`](./todo.md);
- move superseded current-era plans and investigation records to `docs/history/` while preserving links and provenance;
- treat `docs/archive/` as frozen imported legacy context; and
- split an implemented plan with remaining rollout work into a compact active gate/checklist plus frozen implementation history when its size obscures the remaining action.

Do not churn historical files merely to normalize style. Archive when a document is misleading in the active map or when a focused cleanup can preserve its references safely.

## Provider compatibility review

Review [`compatibility-watchlist.md`](./compatibility-watchlist.md) when provider releases change native hooks, approval routing, failure events, history/session identity, or exact-resume behavior. Move an item into the active backlog only after the upstream capability exists and the local acceptance criteria are known.
