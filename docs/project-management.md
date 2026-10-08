# Project names, availability, and relocation

Project identity is the indexed `projectId`, independent of the project folder and its display name. The project state directory, board, tasks, groups, and session history retain that identity through naming and location changes.

## User behavior

- An unavailable folder remains in the project list and its saved board remains readable. Show **Folder unavailable** with **Locate folder…** and **Check again**. Unavailability never authorizes deleting project state.
- **Rename project…** sets an optional display name; clearing it restores the folder name. It has no filesystem or session effects.
- **Locate folder…** reconnects the existing project to a selected directory. It validates the directory and project mode, rejects another project's registered path, and repairs owned Git worktree links.
- **Rename folder on disk…** accepts one new folder name and derives the sibling destination on the server. It rejects existing destinations and does not implement a cross-volume copy/delete fallback. Registered descendant projects prevent this operation; externally moved descendants can each be located separately.
- Location changes stop task agents and shells. They preserve resume identities and leave sessions stopped for explicit restart.
- Location changes require exclusive use of the saved state by one runtime. Main Git checkouts and folder projects are supported; linked Git project roots need their Git layout repaired outside this operation.

## Ownership

1. The project index owns the optional display name, location, directory identity when available, and a metadata revision separate from board revisions. New metadata upgrades the index to version 3 so older runtimes cannot silently strip it. Existing version 1 and 2 indexes remain readable.
2. Saved-state loading by project ID is independent of Git and root-directory availability and retains the existing project-state transaction boundary. Runtime availability observation controls filesystem and process admission, not retention.
3. One project-wide operation gate drains existing work and fences new operations during relocation. Every admitted operation revalidates its scope after waiting. Task lifecycle and durable board changes retain their existing owners.
4. A relocation filesystem service validates paths and exact worktree ownership, performs the rename and Git repair, and owns a bounded journal in stable Quarterdeck state. Runtime orchestration stops execution owners, shells, metadata/code-navigation work, and persistence writers before applying relocation.
5. Existing managed worktrees keep their physical paths, even when their folder label reflects the former project name. Persisted task paths govern later archive, restore, and deletion. Paths within the old project root are rebased at directory boundaries; opaque provider identities are never rewritten.
6. The runtime refreshes remembered paths, managers, configuration, and metadata before publishing authoritative project state and summaries. The browser preserves project/task identity, invalidates old path scopes, guards dirty editor buffers before requested moves, and preserves recovery drafts when paths change externally.

Management endpoints are `projects.rename`, `projects.locate`, `projects.renameFolder`, and `projects.checkAvailability`. Location requests capture the expected current path. Results carry the updated summary and authoritative state when needed. Availability and metadata ordering must not depend on board revision. The browser/runtime protocol advances for these new required operations.

## Failure and identity rules

Validate before stopping sessions, then revalidate under exclusive admission. Passive availability checks and managed disk renames require the known directory identity to match. Explicit Locate permits an identity change, including a remounted drive or a move across volumes, after structural validation of the selected folder. Any existing task worktrees require exact administrative-link evidence; matching Git remotes or commits is never proof of worktree ownership. The selected directory's current identity then guards the remaining operation and recovery.

The relocation journal records the old and new locations and filesystem identity before effects. Interrupted operations are resolved before startup recovery. Failures preserve task files and saved state; ambiguous recovery remains blocked with an actionable error. Recovery must neither create a second project nor launch a task against the old location.

Locate can retry a pending rename using its exact journaled destination even when the filesystem move has not happened yet. Recovery still verifies the recorded source identity before moving it; selecting an unrelated destination cannot redirect the pending operation.

Destination existence and identity are checked immediately before the filesystem rename and identity is checked afterward. Node's portable rename API has no atomic no-replace option; an unrelated process creating an empty destination between the check and rename remains a platform limitation.

## Diagnosing availability

Git projects require both directory access and a successful Git root check; folder projects bypass Git. A failed Git command can therefore make Git projects unavailable while folder projects remain accessible. Compare launch environments and retained `project.git_validation_failed` diagnostic events before treating the saved path as missing or relocating it. Those events retain bounded failure categories, process error/exit codes, and project identity without Git output, environment values, or repository paths.

## Validation boundaries

Focused filesystem and runtime tests cover missing-folder retention, name persistence, stale requests, duplicate destinations, project-wide exclusion, confirmed session shutdown, exact Git repair, stable worktree paths, journal interruption, and startup recovery. Frontend tests cover dialogs, unavailable read-only state, metadata ordering, dirty buffers, and same-ID path invalidation.

A deterministic Agent Lab scenario covers the browser/runtime boundary: external rename, unavailable reconnect and cold restart, Locate, display rename, disk rename, retained tasks and worktree contents, and explicit fake-agent restart. Use focused filesystem tests for interruption boundaries and exact worktree ownership. Real providers are unnecessary for this path-management contract.
