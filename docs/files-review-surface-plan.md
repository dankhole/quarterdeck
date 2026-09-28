# Files and Review Surface Migration

Status: staged follow-up to the [Editor-lite backlog](./todo.md#editor-lite-follow-ups). The editable Files view is implemented; compare, commit diffs, and conflict resolution still have independent presentation paths. This plan defines the next boundaries to share without losing review behavior.

## Existing ownership

| Boundary | Current owner | Keep authoritative |
| --- | --- | --- |
| Project/task/ref identity and write eligibility | `file-browser-scope.ts` | Live worktrees may be editable; ref snapshots are read-only. |
| File discovery and content requests | `use-file-tree-data.ts`, `use-file-content-data.ts`, `use-file-browser-data.ts` | Scope changes reject stale results; writes use expected content hashes. |
| Open documents and unsaved buffers | `file-editor-workspace.ts`, `use-file-editor-workspace.ts` | Dirty buffers survive ordinary navigation and require explicit save/discard. |
| Compare/uncommitted data | `use-git-diff-data.ts`, `use-all-file-diff-content.ts` | Selected/visible content priority and bounded prefetch remain separate from rendering. |
| Commit review | `GitCommitDiffPanel` | Commit patches, renamed/deleted/binary paths, file statistics, and review navigation. |
| Merge/rebase progress and mutation | `use-conflict-resolution.ts`, `ConflictResolutionPanel` | Conflict state, ours/theirs, optional auto-merge review, continue, and abort. |

Paths above are under `web-ui/src/hooks/git`, `web-ui/src/runtime`, and `web-ui/src/components/git`. Share domain and editor behavior at these boundaries; do not make `FilesView` a universal component that owns Git operations.

## Sequence

### 1. Read-only commit review

Start with the smallest surface that cannot lose unsaved edits. Define a typed review-document identity containing repository scope, revision pair, old/new paths, and document kind. Keep it distinct from a live editable document so identical paths at different revisions cannot share buffers or save capabilities.

Reuse the editor's language, theme, selection, and content presentation facilities where appropriate, with a dedicated diff presentation contract. Commit data currently provides patches rather than complete old/new file contents: decide explicitly whether the renderer consumes patches or requests revision content before changing that API. Never reconstruct a supposedly complete file from a partial patch. Preserve commit selection, file statistics, rename/delete/binary states, loading/error states, and file/line navigation.

Acceptance: changing commits or repository scopes cannot show stale content; review documents expose no save path; existing commit-review navigation remains available. Focused domain/component tests establish these contracts, then one deterministic Agent Lab Git scenario checks the integrated surface.

### 2. Compare and uncommitted review

Reuse the review-document contract after commit review establishes it. Retain compare base/head semantics, unified/split review, comments and hunk context, selected-file priority, and visible-file reporting. A working-copy diff is a review snapshot; opening its live file for editing must enter the existing editable scope explicitly.

Measure first-open and selected-file latency before choosing further performance changes. Use bounded diagnostic marks to separate Git, serialization/transfer, diff calculation, and rendering. Sharing presentation does not establish a performance improvement. Keep cancellation, caching, prefetch, and any virtualization policy outside document correctness.

Acceptance: deleted/renamed paths and binary/large files retain correct review states; rapid selection changes cannot apply stale results; hidden review surfaces do not resume file polling. Validate the touched data/rendering owners and one lab compare/uncommitted scenario.

### 3. Editable conflict resolution

Reuse the existing dirty-buffer lifecycle in [file-editor-cache.ts](../web-ui/src/hooks/git/file-editor-cache.ts), [use-file-editor-workspace.ts](../web-ui/src/hooks/git/use-file-editor-workspace.ts), and [file-editor-drafts-dialog.tsx](../web-ui/src/components/git/file-editor-drafts-dialog.tsx). Sharing writable documents must preserve scope-generation checks, hidden dirty/saving-tab guards, and detached draft recovery when project/task/worktree scopes are deleted or replaced. Verify those guarantees through the conflict-specific mutation paths below; the existing owners do not establish acceptance for the new integration. Read-only migrations above do not require writable-document integration.

Keep merge/rebase operation state and continue/abort commands in their existing Git owner. Represent base/ours/theirs as immutable sources and the worktree result as the only editable document. Saving a result is distinct from staging or marking it resolved. Reuse expected-content-hash protection and make any resolve/stage gesture explicit. Define how unsaved result buffers are handled before ours/theirs replacement, continue, abort, or worktree deletion; none may silently overwrite a dirty tab.

Acceptance: manual edits can be saved and explicitly resolved; disk changes cannot be overwritten silently; continue remains unavailable while conflicts remain; abort and scope teardown preserve the chosen dirty-buffer contract. Test the mutation/error paths and one deterministic conflicting Git fixture.

## Completion criteria

Remove an old renderer or cache only after its callers use the shared contract and its review behaviors have corresponding coverage. Keep each migrated surface independently reviewable. Update the active backlog per completed slice; retain the broader item until compare, commit review, and conflict resolution have all been assessed and the intended shared ownership is documented.

Follow [Architecture Guardrails](./conventions/architecture-guardrails.md), [Frontend Hooks](./conventions/frontend-hooks.md), [UI Layout](./conventions/ui-layout.md), and the [Testing Strategy](./testing.md). Real providers and active user instances are unnecessary for this migration.
