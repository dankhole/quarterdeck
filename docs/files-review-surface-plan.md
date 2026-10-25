# Files and review surfaces

This document owns the implemented Files/review contract. Commit, compare, uncommitted, and conflict review share the Files/editor foundation. Git data loading and operation ownership remain separate from editor presentation and writable buffer lifecycle.

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

## Syntax highlighting

Files, conflict editors, search result previews, and rendered review rows share CodeMirror's maintained language catalog, one resolver, and the editor palette. The catalog recognizes language aliases, filename extensions, and special filenames such as `Dockerfile`; grammar coverage follows the installed `@codemirror/language-data` release rather than a separate per-view language list. It is broad but not universal: files such as Makefiles or languages absent from the catalog remain plain text unless an existing review fallback is available. File-backed views use the actual filename instead of the runtime's older, coarser language hints. Explicit supported hints remain available to embedded editor callers.

Existing core grammars are available immediately; additional grammars load on demand from bundled application assets, not a CDN or executable installer. Files stay editable while a grammar loads. Unknown files and failed loads remain usable without highlighting; review views retain their available Prism fallback. Grammar completion updates highlighting without replacing the editor's document, selection, or undo history. Navigation and LSP installation remain separate, optional operations. Rendered Markdown fenced code blocks retain their separate Prism highlighter; loading an editor grammar does not expand that renderer's language coverage.

Grammar quality varies by language. C# uses CodeMirror's maintained stream tokenizer: records, init accessors, comments, and ordinary/verbatim strings receive lexical highlighting, but interpolation expressions remain string-colored and raw strings do not have full grammar support.

Complete editors retain multiline tokenizer state. Review rows and inline diff segments are independent fragments, so multiline comments and strings can differ from their full-file appearance. Fragment highlighting preserves HTML escaping and the existing 20,000-character line-length bound; it does not treat partial patches as complete files. C# review fragments longer than 10,000 characters retain Prism highlighting because the stream tokenizer stops tokenizing long lines; these exceptional rows use Prism's palette. Languages without a shared editor grammar also retain the review renderer's Prism fallback.

## Commit review

`GitCommitDiffPanel` creates immutable review documents and supplies patches directly to the shared presenter. Patch line numbers, added/deleted/renamed/binary files, statistics, collapse, file navigation, loading, and errors remain available. Commit data responses carry their request scope and selected commit identity; switching commits or repositories masks old data immediately and rejects late responses.

## Compare and uncommitted review

`DiffViewerPanel` supplies complete old/new content to the same presenter. Split/unified mode, comments, context expansion, hunk prompts, selected-file priority, and visible-file reporting retain their existing owners. Compare option changes clear comments tied to the previous comparison. Working-copy review stays immutable; writable content enters the existing live Files scope explicitly.

This migration makes no performance improvement claim. Track remaining performance work in the primary checkout's local `docs/qDeck.yaml`. Measure first-open and selected-file latency with bounded diagnostic marks before further changes to calculation, transfer, prefetch, or virtualization. Highlighting remains limited to rendered rows and bounded line lengths.

## Conflict results

`ConflictResultEditor` combines immutable base/ours/theirs sources with the live Files workspace and embedded `FileEditorPanel`. Choosing ours or theirs changes only the result buffer. Autosave is off here; Save uses the existing expected-content-hash contract and does not stage or resolve the file. **Stage & Mark Resolved** explicitly stages saved text after checking its hash and rejecting remaining conflict markers. The check and stage share the Files save lock. Noneditable results retain explicit complete-side staging actions.

Replacement, resolve/stage, continue, and abort consult the shared cache guard for the exact project/task, including hidden dirty or saving tabs. The existing drafts dialog handles save/discard decisions; the original operation must be retried explicitly. Continue also requires authoritative Git metadata to report no unresolved files. Operation/scope changes reset review state, and stale asynchronous completions cannot apply to another operation. Navigation preserves unsaved results, while task/worktree retirement detaches protected drafts through the existing lifecycle owner.

## Validation

Focused tests cover document identity, rendered-row highlighting, commit selection races, comments/context/hunk behavior, content loading, conflict save/stage and disk-change failures, hidden dirty/saving guards, scope retirement, and detached recovery. Runtime tests exercise hash-protected staging against a real disposable Git conflict. Deterministic Agent Lab scenarios check integrated commit/compare/uncommitted review and the explicit conflict workflow; no real provider or active user instance is needed.

Follow [Architecture Guardrails](./conventions/architecture-guardrails.md), [Frontend Hooks](./conventions/frontend-hooks.md), [UI Layout](./conventions/ui-layout.md), and the [Testing Strategy](./testing.md).
