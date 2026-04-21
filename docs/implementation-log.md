# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Consolidate refactor tracking docs (2026-04-21)

Reduced the number of standalone refactor tracking documents by folding completed-item context back into parent docs and centralizing the backlog in fewer files.

**What changed:**

- Deleted `docs/optimization-shaped-architecture-followups.md` — its 4 subsystem descriptions and the optimization-shaped heuristic were inlined into `docs/refactor-roadmap-context.md` as a "Recently Closed Out" summary and per-item status markers.
- Deleted `docs/project-metadata-monitor-followups.md` — the two follow-up sections (shared mutable entry coupling and refresh overwrite races) were appended to `docs/project-metadata-monitor-refactor-brief.md` under a new "Post-landing Follow-ups" heading.
- Expanded `docs/refactor-roadmap-context.md` with: active-order list matching `todo.md`, status markers on all existing sections (completed vs active), a "Recently Completed Refactors" summary, and an "Extended Backlog" with 9 new code-validated refactor targets (#9–#17) covering terminal session lifecycle, project/worktree identity, notification scoping, LLM client abstraction, orphan cleanup, indicator state, branch/base-ref UX, file browser pipeline, and task-detail composition.
- Restructured `docs/todo.md` with a tracking note header, "Additional code-validated refactor backlog" section linking each new roadmap item, "Historical completed roadmap programs" separator, and "Broader refactor context" links on existing bug items.
- Updated `docs/README.md` with a quick-start shortcut section and removed references to deleted files.
- Fixed cross-references in `docs/design-guardrails.md`, `docs/design-weaknesses-roadmap.md`, and `docs/terminal-ws-server-refactor-brief.md` to point at `refactor-roadmap-context.md` instead of the deleted files.

**Why:** Two standalone follow-up docs had drifted into "completed but still tracked separately" status, and the refactor backlog was split across too many files. Consolidating reduces the number of docs a new agent or engineer needs to read to understand what's active vs done, and makes the roadmap context document the single entry point for both active and extended backlog items.
