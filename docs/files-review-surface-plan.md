# Files and Review Surface Migration

Status: implemented. Commit, compare, uncommitted, and conflict review share the Files/editor foundation. Git data loading and operation ownership remain separate from editor presentation and writable buffer lifecycle.

## Ownership

| Boundary | Owner | Invariant |
| --- | --- | --- |
| Project/task/ref identity and write eligibility | `file-browser-scope.ts` | Live worktrees may be editable; ref snapshots are read-only. |
| Review document identity | `review-document.ts` | Repository scope, revision pair, old/new paths, kind, and available content revision identify immutable snapshots. No writable scope or save callback is exposed. |
| Review content admission | `components/editor/review-document-diff.tsx` | Patches and complete old/new text are different inputs. Partial patches never become supposedly complete files. Binary, loading, unavailable, and rename states are explicit. |
| Language and palette | `components/editor/source-presentation.ts`, `source-line-highlighting.ts` | Files and rendered review rows use the same CodeMirror language definitions and highlight palette; unsupported editor languages retain the existing Prism fallback. |
| File discovery and content requests | `use-file-tree-data.ts`, `use-file-content-data.ts`, `use-file-browser-data.ts` | Scope/generation changes reject stale results; writes use expected content hashes. |
| Open documents and unsaved buffers | `file-editor-cache.ts`, `use-file-editor-workspace.ts` | Files and conflict results share live scope identities. Dirty buffers survive navigation; retired scopes preserve detached drafts. |
| Compare/uncommitted data | `use-git-diff-data.ts`, `use-all-file-diff-content.ts` | Selected/visible content priority, cancellation, and bounded prefetch remain separate from document correctness. Hidden compare/uncommitted surfaces stop their data work. |
| Git review interactions | `GitCommitDiffPanel`, `DiffViewerPanel`, split/unified row renderers | Preserve file statistics, navigation, context expansion, selection, comments, and agent hunk actions. |
| Merge/rebase/revert progress and mutation | `use-conflict-resolution.ts`, `ConflictResolutionPanel`, runtime `git-conflict.ts` | Saving, staging, completing, and aborting remain distinct commands. Git owns operation state. |

Hook paths are under `web-ui/src/hooks/git` unless qualified; component paths are under `web-ui/src`. `FilesView` does not own Git operations. Existing row renderers remain review-specific presentation primitives behind the shared document contract, rather than a second writable editor or buffer cache.

## Commit review

`GitCommitDiffPanel` creates immutable review documents and supplies patches directly to the shared presenter. Patch line numbers, added/deleted/renamed/binary files, statistics, collapse, file navigation, loading, and errors remain available. Commit data responses carry their request scope and selected commit identity; switching commits or repositories masks old data immediately and rejects late responses.

## Compare and uncommitted review

`DiffViewerPanel` supplies complete old/new content to the same presenter. Split/unified mode, comments, context expansion, hunk prompts, selected-file priority, and visible-file reporting retain their existing owners. Compare option changes clear comments tied to the previous comparison. Working-copy review stays immutable; writable content enters the existing live Files scope explicitly.

This migration makes no performance improvement claim. The [performance backlog](./todo.md#files-view-and-git-diff-performance) remains active. Measure first-open and selected-file latency with bounded diagnostic marks before further changes to calculation, transfer, prefetch, or virtualization. Highlighting remains limited to rendered rows and bounded line lengths.

## Conflict results

`ConflictResultEditor` combines immutable base/ours/theirs sources with the live Files workspace and embedded `FileEditorPanel`. Choosing ours or theirs changes only the result buffer. Autosave is off here; Save uses the existing expected-content-hash contract and does not stage or resolve the file. **Stage & Mark Resolved** explicitly stages saved text after checking its hash and rejecting remaining conflict markers. The check and stage share the Files save lock. Noneditable results retain explicit complete-side staging actions.

Replacement, resolve/stage, continue, and abort consult the shared cache guard for the exact project/task, including hidden dirty or saving tabs. The existing drafts dialog handles save/discard decisions; the original operation must be retried explicitly. Continue also requires authoritative Git metadata to report no unresolved files. Operation/scope changes reset review state, and stale asynchronous completions cannot apply to another operation. Navigation preserves unsaved results, while task/worktree retirement detaches protected drafts through the existing lifecycle owner.

## Validation

Focused tests cover document identity, rendered-row highlighting, commit selection races, comments/context/hunk behavior, content loading, conflict save/stage and disk-change failures, hidden dirty/saving guards, scope retirement, and detached recovery. Runtime tests exercise hash-protected staging against a real disposable Git conflict. Deterministic Agent Lab scenarios check integrated commit/compare/uncommitted review and the explicit conflict workflow; no real provider or active user instance is needed.

Follow [Architecture Guardrails](./conventions/architecture-guardrails.md), [Frontend Hooks](./conventions/frontend-hooks.md), [UI Layout](./conventions/ui-layout.md), and the [Testing Strategy](./testing.md).
