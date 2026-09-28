# Backlog Execution Plan

This plan sequences the active work in [todo.md](./todo.md). It is an ownership and dependency map, not a claim that every feature or acceptance gate is complete.

## Parallel implementation

The initial implementation used ten parallel lanes plus one integration owner. Runtime lifecycle and editor ownership work receive the deepest review; isolated presentation work uses a smaller reasoning scope.

| Lane | Boundary | Dependency or completion evidence |
| --- | --- | --- |
| Codex approval cancellation | Current-launch interruption detector and permission retirement | Reject historical interruptions; focused detector and session-manager regressions |
| Architecture and acceptance | Shell policy, rendered approval inspection cost, review-surface migration plan | Preserve native-hook authority; measure before optimizing; retain external gates |
| Files performance | File tree construction and active Files costs | Synthetic before/after profile, tree tests, active Files browser check |
| Git diff performance | Diff parsing, row rendering, selected-file delivery | Measured cost and bounded fixes; preserve selected/visible-first fetch policy |
| Sidebar commit performance | Commit completion and post-commit refresh | Preserve hooks and truthful commit outcome; measure phases separately |
| LSP runtime | Opt-in config, protocol, scoped processes, navigation API | Structured trusted commands, unsaved-buffer sync, bounded requests, cleanup and path tests |
| LSP frontend | Settings, editor commands, results navigation | Agreed runtime contract; no independent editor cache or scope authority |
| Editor cache lifecycle | Hidden dirty buffers and destructive-scope guards | Save/discard before removal; retain recoverable orphan drafts; prune clean deleted scopes |
| Revert commit | Scoped Git operation, history action, conflict continuation | Synthetic Git fixtures and browser flow; preserve history |
| Search preview | Highlighted-result read-only preview | Keyboard focus, scope/request fencing, narrow-layout inspection |

The integration owner owns dependency manifests, shared backlog/changelog updates, final review, and aggregate validation. Agents coordinate changes to shared routers and editor components before editing them. The initial implementation was committed as `6c0dd94d`; branch-review fixes and code-smell cleanup followed, with local `main` incorporated in `908cb1f4`.

## Sequenced editor work

1. Establish cache lifecycle and the editor action/range contract alongside the LSP runtime API.
2. Add selected-range, file, and diff-hunk prompt actions using the existing task-input API and exact session identity.
3. Migrate review surfaces in bounded stages. Preserve compare, conflict resolution, patch semantics, and review navigation; do not replace them with presentation-only wrappers around Files.

## Result of the first parallel pass

Implemented and integrated: the Codex Tip-row cancellation fix, wide-tree construction, bounded diff highlighting and deferred rows, sidebar commit completion, opt-in LSP navigation, editor/agent context actions, hidden-draft lifecycle protection, Revert commit, and search previews. Cross-review covered LSP process shutdown/admission races, editor scope generations, and failed-hook revert recovery.

Remaining active work is listed in [todo.md](./todo.md): end-to-end first-open profiling, pathological exact line-diff computation/full virtualization, staged review-surface migration, later LSP polish/compatibility, and external native/provider gates. The migration plan is a design handoff; its surfaces have not been replaced.

Validation on the integrated worktree: production build; complete web suite (184 files, 1,266 tests); root gate instruction/format/type checks plus root tests (218 passing files, 2,194 passing tests, 8 skipped tests) across the initial run and scoped repairs. The initial root command failed under socket sandbox restrictions and stale fixtures; all failures passed on affected reruns. No second umbrella run was needed. Three fixture corrections preserve current task-color normalization, Git discovery isolation, and native interruption authority.

Fake Agent Lab `backlog-acceptance-20260927T233258Z-4586fd` verified responsive filename previews, a 5,000-file repository, deferred 300-line split diff navigation, sidebar commit/refresh, history-preserving revert, LSP startup only on demand and unsaved definition/hover content, exact result selection, explicit context delivery, and hidden project/task draft guards. Desktop/narrow preview screenshots were inspected. Shutdown completed with no forbidden host launches and no remaining recorded browser/runtime/LSP processes. No real provider, active user instance, native Windows run, or release operation was used.

## Review follow-up

The branch review's eleven findings were assigned to parallel owners, followed by an independent code-smell pass and scoped cleanup. Follow-up covers generation-fenced editor content, attached draft discard, dependency target navigation, CRLF context delivery, stable diff comment/selection identity, semantic settings resets, configured environment checks, required runtime APIs, safe failure metadata, Windows process ownership, and the existing migration-plan prerequisites. Additional checks addressed committed settings changes followed by response failure, concurrent project-field publication, Windows argument transport, and short file reads. See the [implementation log](./implementation-log.md) for ownership details and validation. Remaining active work and external acceptance gates stay in [todo.md](./todo.md).

Final follow-up validation passed runtime/web type checks and the production build, 1,291 web tests followed by affected cleanup regressions, focused runtime tests, and isolated fake Agent Lab checks for read-only dependency navigation, usable editors after draft discard, and whole-file/selection CRLF context delivery. The lab runs stopped cleanly. Native Windows execution and real-provider compatibility remain separate acceptance gates.

## Product decision

Home and task shell terminals close and dispose when their panel or context closes. The user confirmed this contract on 2026-09-27; persistent shell tabs are outside this execution plan.

## External acceptance gates

- Removing the Codex rendered approval shim requires upstream structured-hook parity and authorized real-provider compatibility evidence. Unpaired TUI maintenance signals remain activity-only.
- Windows code remediation is complete, but the experimental label remains until native CI passes on the exact committed revision and the authenticated non-administrator/provider/privacy matrix is completed. macOS validation cannot replace these gates.

## Validation

Follow [testing.md](./testing.md): each lane runs focused tests for its changed invariant. After shared contracts settle, reconcile the tree, review integration seams, run the relevant type/build and test gates once, and use narrow deterministic Agent Lab scenarios for browser/runtime, Files/Git, and visual claims. Stop every lab run. Do not attach to the user's running application or use real providers without explicit authorization.
