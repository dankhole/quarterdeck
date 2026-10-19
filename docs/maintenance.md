# Repository maintenance

## Documentation lifecycle

Quarterdeck's documentation serves developers using and maintaining the current product. Keep it small enough to navigate without reading a chronological history.

| Information | Home |
| --- | --- |
| Installation and first use | Root README, with links to details |
| Current usage, configuration, and troubleshooting | The owning user or operator guide |
| Build, development, and validation commands | DEVELOPMENT.md and the testing guide |
| Architecture, invariants, and consequential rationale | The owning architecture or convention document |
| Routine changes and validation results | PR description and Git history |
| Published changes | Generated GitHub Release notes |
| Work still to do | Local Chit backlog in the primary checkout |
| Superseded plans and historical evidence | `docs/history/` |

### When to write

Update an existing guide when a change alters its instructions or contract. A fix, refactor, completed todo, or passing test suite does not automatically need a documentation entry. Do not maintain `CHANGELOG.md`, append to the retired implementation log, or replace either with another chronological work diary.

Preserve reasoning when a future maintainer could otherwise repeat a costly investigation or undo a consequential decision: a rejected architectural alternative, a recovery invariant, a migration constraint, or a significant incident. Prefer a short section in the document that owns the behavior. A separate decision or incident document is warranted only when the subject needs its own durable reference. State the context, decision, consequences, and essential evidence; avoid transcripts, exhaustive changed-file lists, test-count recaps, and agent handoff narratives.

Breaking changes and migrations need explicit user actions alongside the affected workflow. Call them out in the release PR so they are discoverable from generated notes. Release notes are a summary, not an upgrade procedure.

### Keep current and historical material separate

- Edit current guidance in place. Do not stack dated corrections that require readers to reconstruct today's behavior.
- Move completed or superseded plans to history after preserving any still-applicable constraints in the current guide. Keep incomplete work in Chit rather than a parallel Markdown checklist.
- Keep acceptance ledgers focused on current gates, exact candidate identity, concise receipts, and limitations. Archive verbose run narratives; never turn a historical pass into evidence for a different build or platform.
- Preserve useful historical text and provenance. Fix links affected by a move, and retain a short forwarding page when an external or backlog reference needs its original path.
- Archived instructions are historical evidence, not active policy. Read archives only when the current guide and code cannot answer the question.
- Keep `docs/archive/` as frozen imported legacy material. New historical records belong in `docs/history/`.

Review documentation as part of the change that affects it; no separate recurring diary or mandatory per-change note is needed. Use the [documentation map](README.md) and [proportionate validation policy](testing.md).

## Upstream review

Review the diverged [`cline/kanban`](https://github.com/cline/kanban) upstream when active development makes a review useful. Use [upstream-sync.md](upstream-sync.md) as the Adopted / Backlog / Decided-against record and update its last-checked commit and date after a review.

Quarterdeck removed the Cline SDK/account layer and has diverged substantially. Evaluate ideas first and expect reimplementation rather than direct cherry-picks. Do not preserve a calendar cadence when there is no actionable upstream activity.

## Provider compatibility review

Review the [provider watchlist](compatibility-watchlist.md) when provider releases change native hooks, approval routing, failure events, history/session identity, or exact resume. Move an item into the primary checkout's local Chit backlog only after the upstream capability exists and the local acceptance criteria are known.
