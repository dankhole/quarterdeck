# Remove Commit/PR Prompt Injection Buttons — Implementation Plan

## Overview

Remove the commit and create PR buttons from all UI surfaces (board cards, sidebar cards, agent terminal panel), along with the auto-review commit/PR modes, prompt template configuration, and all backing infrastructure. These buttons are purely prompt injection — they paste a template string into the agent's terminal and press Enter. They give the impression of real git integration but are strictly worse than skills (user-configurable, context-aware). Real git operations will live in the diff viewer (#6) and git management view (#10).

## Current State

- **Commit/PR buttons** render in 3 locations:
  - Board cards in the "review" column (`web-ui/src/components/board-card.tsx:585-616`)
  - Sidebar cards via `ColumnContextPanel` reusing `BoardCard` (`web-ui/src/components/detail-panels/column-context-panel.tsx:203-206`)
  - Agent terminal panel via `AgentTerminalReviewActions` sub-component (`web-ui/src/components/detail-panels/agent-terminal-panel.tsx:53-97`)
- **Auto-review system** (`web-ui/src/hooks/use-review-auto-actions.ts`) automatically fires the same prompt injection when tasks enter the review column. Has 3 modes: `"commit"`, `"pr"` (both prompt injection), and `"move_to_trash"` (real board state mutation).
- **Prompt templates** are configurable in the settings dialog (`web-ui/src/components/runtime-settings-dialog.tsx:602-655`) under "Git button prompts". Templates stored in `~/.quarterdeck/config.json` via `runtime-config.ts`.
- **Props threading chain**: `App.tsx` destructures 4 handlers + 4 loading maps from `useGitActions` and threads them through `QuarterdeckBoard` → `BoardColumn` → `BoardCard` and `CardDetailView` → `AgentTerminalPanel` / `ColumnContextPanel`.
- **Core logic**: `useGitActions` hook (`web-ui/src/hooks/use-git-actions.ts`) contains both prompt injection code (to remove) and legitimate git sync/branch/history code (to keep).

## Desired End State

- No commit or PR buttons anywhere in the UI
- Auto-review simplified to a single `"move_to_trash"` mode (checkbox only, no mode dropdown)
- No prompt template settings in the config or settings UI
- `use-git-actions.ts` contains only git sync, branch switching, discard, and history functionality
- Terminal panel automatically fills the space previously occupied by buttons (flex layout handles this)
- All tests pass, no dead code or unused imports

## Out of Scope

- **Building replacement UI**: No quick actions menu (#16), no new buttons. Users can type skills/prompts directly into the terminal.
- **Server-side commit**: That's planned feature #6, a separate effort.
- **Changing auto-review `move_to_trash` behavior**: This stays as-is.
- **Changing the `autoReviewEnabled` / `autoReviewMode` fields on persisted board cards**: Existing cards with `autoReviewMode: "commit"` or `"pr"` will be treated as `move_to_trash` by the simplified resolver. No migration needed.

## Dependencies

None. This is a self-contained deletion with no external dependencies.

## Implementation Approach

Work from the UI leaves inward: remove buttons and props first, then simplify auto-review, then remove the backing prompt infrastructure, then clean up config/API, then update tests. Each phase is independently buildable.

---

## Phase 1: Remove Commit/PR Buttons from All UI Surfaces

### Overview

Delete the commit/PR button JSX and remove all related props from the component tree. The terminal panel's flex layout automatically reclaims the button space.

### Changes Required

#### 1. Remove `AgentTerminalReviewActions` from agent terminal panel

**File**: `web-ui/src/components/detail-panels/agent-terminal-panel.tsx`

- Delete the `AgentTerminalReviewActions` sub-component (lines 53-97)
- Remove `onCommit`, `onOpenPr`, `isCommitLoading`, `isOpenPrLoading` from `AgentTerminalPanelProps` (lines 29-32)
- Remove these props from `AgentTerminalPanelLayout` destructuring and its rendering of `AgentTerminalReviewActions` (around line 289)
- Remove these props from the `AgentTerminalPanel` component's pass-through to `AgentTerminalPanelLayout`
- The terminal container div (`flex: "1 1 0"`) automatically expands to fill the removed ~48px

#### 2. Remove commit/PR button JSX and props from `BoardCard`

**File**: `web-ui/src/components/board-card.tsx`

- Remove `onCommit`, `onOpenPr` callback props (lines 148-149, 175-176)
- Remove `isCommitLoading`, `isOpenPrLoading` props (lines 154-155, 181-182)
- Remove `showReviewGitActions` derived state (line 256) and `isAnyGitActionLoading` (line 257)
- Delete the commit/PR button JSX block (lines 585-616)

#### 3. Remove prop threading from `BoardColumn`

**File**: `web-ui/src/components/board-column.tsx`

- Remove `onCommitTask`, `onOpenPrTask` props (lines 23-24, 56-57)
- Remove `commitTaskLoadingById`, `openPrTaskLoadingById` props (lines 31-32, 64-65)
- Remove these props from `BoardCard` rendering (lines 194-195, 200-201)

#### 4. Remove prop threading from `QuarterdeckBoard`

**File**: `web-ui/src/components/quarterdeck-board.tsx`

- Remove `onCommitTask`, `onOpenPrTask` props (lines 42-43, 72-73)
- Remove `commitTaskLoadingById`, `openPrTaskLoadingById` props (lines 50-51, 80-81)
- Remove these props from `BoardColumn` rendering (lines 403-404, 411-412)

#### 5. Remove prop threading from `ColumnContextPanel`

**File**: `web-ui/src/components/detail-panels/column-context-panel.tsx`

- Remove `onCommitTask`, `onOpenPrTask` props from both `ColumnSection` (lines 27-28, 54-55, 203-204) and `ColumnContextPanel` (lines 252-253, 278-279, 374-375)
- Remove `commitTaskLoadingById`, `openPrTaskLoadingById` props from both components (lines 34-35, 61-62, 205-206, 259-260, 285-286, 381-382)

#### 6. Remove prop threading from `CardDetailView`

**File**: `web-ui/src/components/card-detail-view.tsx`

- Remove `onCommitTask`, `onOpenPrTask`, `onAgentCommitTask`, `onAgentOpenPrTask` props (lines 239-242, 291-294)
- Remove `commitTaskLoadingById`, `openPrTaskLoadingById`, `agentCommitTaskLoadingById`, `agentOpenPrTaskLoadingById` props (lines 250-253, 302-305)
- Remove these props from `ColumnContextPanel` rendering (lines 672-673, 679-680)
- Remove these props from `AgentTerminalPanel` rendering (lines 893-896)

#### 7. Remove handler/loading map destructuring from `App.tsx`

**File**: `web-ui/src/App.tsx`

- Remove `handleCommitTask`, `handleOpenPrTask`, `handleAgentCommitTask`, `handleAgentOpenPrTask` from `useGitActions` destructuring (lines 422-425)
- Remove `commitTaskLoadingById`, `openPrTaskLoadingById`, `agentCommitTaskLoadingById`, `agentOpenPrTaskLoadingById` from destructuring (lines 410-413)
- Remove these props from `QuarterdeckBoard` rendering (lines 958-959, 964-965)
- Remove these props from `CardDetailView` rendering (lines 1043-1050)

### Success Criteria

#### Automated

- [ ] TypeScript compiles: `npm run web:typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] Web UI tests pass: `npm run web:test` (some may need updates — handled in Phase 5)

#### Manual

- [ ] Board cards in "review" column no longer show Commit/Open PR buttons
- [ ] Agent terminal panel no longer shows Commit/Open PR buttons at bottom
- [ ] Terminal fills full panel height when a task is in review with changed files
- [ ] Sidebar cards in review column no longer show Commit/Open PR buttons

**Checkpoint**: Verify buttons are gone and terminal fills space before proceeding.

---

## Phase 2: Simplify Auto-Review to Move-to-Trash Only

### Overview

Remove the `"commit"` and `"pr"` auto-review modes, simplifying the system to just `"move_to_trash"`. The mode dropdown becomes unnecessary — auto-review becomes a simple on/off toggle for auto-trashing.

### Changes Required

#### 1. Simplify `RuntimeTaskAutoReviewMode` schema

**File**: `src/core/api-contract.ts`

- Change `runtimeTaskAutoReviewModeSchema` from `z.enum(["commit", "pr", "move_to_trash"])` to `z.enum(["move_to_trash"])` (line 106)
- Consider: existing persisted cards may have `"commit"` or `"pr"` values. The Zod schema is used for new card creation, not for reading persisted state. If persisted state validation uses this schema, we need a migration path. If not, the `resolveTaskAutoReviewMode` function handles the fallback.

#### 2. Simplify `resolveTaskAutoReviewMode` and related helpers

**File**: `web-ui/src/types/board.ts`

- Change `DEFAULT_TASK_AUTO_REVIEW_MODE` to `"move_to_trash"` (line 8)
- Simplify `resolveTaskAutoReviewMode` to always return `"move_to_trash"` (lines 10-15) — this handles existing cards with old `"commit"` or `"pr"` values gracefully
- Simplify `getTaskAutoReviewActionLabel` — only one mode now, return `"trash"` (lines 17-26)
- Simplify `getTaskAutoReviewCancelButtonLabel` — return `"Cancel Auto-Trash"` (lines 28-36)

#### 3. Remove commit/PR code paths from `use-review-auto-actions.ts`

**File**: `web-ui/src/hooks/use-review-auto-actions.ts`

- Remove `TaskGitAction` import (line 3)
- Remove `TaskGitActionLoadingStateLike` interface (lines 15-18)
- Remove `taskGitActionLoadingByTaskId` and `runAutoReviewGitAction` from `UseReviewAutoActionsOptions` (lines 26-27)
- Remove `awaitingCleanActionByTaskIdRef` (line 46) — this tracked post-commit/PR clean state
- Remove the commit/PR arming logic block (lines 189-252) — the mental model comments explain this was for watching changes → triggering commit/PR → then auto-trashing when changes reach 0. With only `move_to_trash` mode, this entire block is unnecessary.
- Simplify `evaluateAutoReview` to only handle `move_to_trash` mode — keep the `scheduleAutoReviewAction` with `move_to_trash` logic (lines 161-187)
- Remove `taskGitActionLoadingByTaskId` from the `useEffect` dependency (line 262)

#### 4. Remove git action dependencies from `use-board-interactions.ts`

**File**: `web-ui/src/hooks/use-board-interactions.ts`

- Remove `TaskGitAction` import (line 5)
- Remove `TaskGitActionLoadingStateLike` interface (lines 31-34)
- Remove `taskGitActionLoadingByTaskId` and `runAutoReviewGitAction` from `UseBoardInteractionsInput` (lines 70-71)
- Remove these from the destructured params (lines 115-116)
- Update `useReviewAutoActions` call (lines 529-530) to remove these params

#### 5. Remove mode dropdown from task create UI

**File**: `web-ui/src/components/task-create-dialog.tsx`

- Keep the `autoReviewEnabled` checkbox (auto-trash toggle)
- Remove the `autoReviewMode` dropdown/select (lines 543-548 area)
- Remove `autoReviewMode` and `onAutoReviewModeChange` props
- When `autoReviewEnabled` is true, always use `"move_to_trash"` implicitly

**File**: `web-ui/src/components/task-inline-create-card.tsx`

- Same changes — keep checkbox, remove mode dropdown
- Remove `autoReviewMode` and `onAutoReviewModeChange` props

#### 6. Update App.tsx auto-review wiring

**File**: `web-ui/src/App.tsx`

- Remove `runAutoReviewGitAction` from `useGitActions` destructuring (line 426)
- Remove `taskGitActionLoadingByTaskId` from destructuring if no longer needed
- Update `useBoardInteractions` call to remove these params (line 657 area)
- Update task create dialog props to remove `autoReviewMode` (lines 804-806, 1131-1133)

### Success Criteria

#### Automated

- [ ] TypeScript compiles: `npm run web:typecheck`
- [ ] Linting passes: `npm run lint`

#### Manual

- [ ] Task create dialog shows "Auto-trash" checkbox but no mode dropdown
- [ ] Inline create card shows "Auto-trash" checkbox but no mode dropdown
- [ ] Existing cards with `autoReviewMode: "commit"` are treated as `move_to_trash`
- [ ] Auto-trash still works: create a task with auto-review enabled, let it reach review, verify it auto-moves to trash

**Checkpoint**: Verify auto-review simplification works before removing backing infrastructure.

---

## Phase 3: Remove Prompt Injection Infrastructure

### Overview

Delete the prompt builder module, remove all commit/PR-specific code from `use-git-actions.ts`, and clean up the `TaskGitAction` type references.

### Changes Required

#### 1. Delete prompt builder module

**Files to delete**:
- `web-ui/src/git-actions/build-task-git-action-prompt.ts`
- `web-ui/src/git-actions/build-task-git-action-prompt.test.ts`
- If the `web-ui/src/git-actions/` directory is now empty, delete it

#### 2. Remove commit/PR code from `use-git-actions.ts`

**File**: `web-ui/src/hooks/use-git-actions.ts`

- Remove `buildTaskGitActionPrompt` and `TaskGitAction` imports (line 4)
- Remove `TaskGitActionSource` type (line 21)
- Remove `TaskGitActionLoadingState` interface (lines 23-26)
- Remove `matchesWorkspaceInfoSelection` helper (lines 71-79) — only used by `runTaskGitAction`
- Remove from `UseGitActionsResult` interface: `taskGitActionLoadingByTaskId`, `commitTaskLoadingById`, `openPrTaskLoadingById`, `agentCommitTaskLoadingById`, `agentOpenPrTaskLoadingById`, `handleCommitTask`, `handleOpenPrTask`, `handleAgentCommitTask`, `handleAgentOpenPrTask`, `runAutoReviewGitAction` (lines 45-67)
- Remove from `UseGitActionsInput`: `runtimeProjectConfig` (line 32) — only used for prompt templates
- Remove all state: `taskGitActionLoadingByTaskId` (lines 92-94), `setTaskGitActionLoading` (lines 145-168), all 4 `*LoadingById` memos (lines 170-208)
- Delete `runTaskGitAction` function (lines 210-314)
- Delete `handleCommitTask`, `handleOpenPrTask`, `handleAgentCommitTask`, `handleAgentOpenPrTask` (lines 316-342)
- Delete `runAutoReviewGitAction` (lines 475-480)
- Remove from `resetGitActionState`: `setTaskGitActionLoadingByTaskId({})` (line 484)
- Remove from return object: all commit/PR related exports (lines 505-525)

#### 3. Delete test file for git actions hook (if exclusively testing removed code)

**File**: `web-ui/src/hooks/use-git-actions.test.tsx`

- Review contents. If it only tests commit/PR prompt injection, delete entirely.
- If it tests git sync/branch/history too, keep those tests and remove commit/PR tests.

#### 4. Update App.tsx to stop passing removed values

**File**: `web-ui/src/App.tsx`

- Remove `runtimeProjectConfig` from `useGitActions` input (if it was the only consumer)
- Remove any remaining references to deleted return values from `useGitActions`

### Success Criteria

#### Automated

- [ ] TypeScript compiles: `npm run typecheck && npm run web:typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] `web-ui/src/git-actions/` directory is deleted or empty

#### Manual

- [ ] App still functions — git sync (fetch/pull/push), branch switching, discard changes all work from the git history panel

**Checkpoint**: Verify git operations still work before touching the backend config.

---

## Phase 4: Remove Prompt Template Config and Settings

### Overview

Remove `commitPromptTemplate` and `openPrPromptTemplate` from the runtime config, API contract, settings dialog, and agent registry.

### Changes Required

#### 1. Remove from API contract

**File**: `src/core/api-contract.ts`

- Remove 4 fields from `runtimeConfigResponseSchema` (lines 558-561): `commitPromptTemplate`, `openPrPromptTemplate`, `commitPromptTemplateDefault`, `openPrPromptTemplateDefault`
- Remove 2 fields from `runtimeConfigSaveRequestSchema` (lines 571-572): `commitPromptTemplate`, `openPrPromptTemplate`

#### 2. Remove from runtime config

**File**: `src/config/runtime-config.ts`

- Remove from `RuntimeGlobalConfigFileShape` (lines 19-20): `commitPromptTemplate`, `openPrPromptTemplate`
- Remove from `RuntimeConfigState` (lines 35-38): all 4 template fields
- Remove from `RuntimeConfigUpdateInput` (lines 47-48): both template fields
- Delete `DEFAULT_COMMIT_PROMPT_TEMPLATE` and `DEFAULT_OPEN_PR_PROMPT_TEMPLATE` constants (lines 58-89)
- Delete `normalizePromptTemplate` helper (line 149)
- Remove template handling from `buildRuntimeConfigState` (lines 263-269)
- Remove template handling from `writeRuntimeGlobalConfigFile` (lines 311-318, 347-351)

#### 3. Remove from agent registry

**File**: `src/terminal/agent-registry.ts`

- Remove template fields from the config passed to agents (lines 114-117)

#### 4. Remove "Git button prompts" section from settings dialog

**File**: `web-ui/src/components/runtime-settings-dialog.tsx`

- Delete the entire "Git button prompts" section (lines 602-655)
- Remove `commitPromptTemplate` and `openPrPromptTemplate` state variables (lines 292-293)
- Remove `selectedPromptVariant` state (line 294)
- Remove `GIT_PROMPT_VARIANT_OPTIONS` constant (line 58)
- Remove `TaskGitAction` import
- Remove `TASK_GIT_BASE_REF_PROMPT_VARIABLE` import
- Remove template normalization helpers
- Remove template fields from `handleSave` payload (lines 520-521)
- Remove template initialization in the dialog open effect (lines 399-419 area)

#### 5. Remove from frontend config query layer

**File**: `web-ui/src/runtime/runtime-config-query.ts`

- Remove `commitPromptTemplate` and `openPrPromptTemplate` from `saveRuntimeConfig` interface (lines 25-26)

**File**: `web-ui/src/runtime/use-runtime-config.ts`

- Remove template fields from the save function interface (lines 17-19, 85-86)

### Success Criteria

#### Automated

- [ ] TypeScript compiles: `npm run typecheck && npm run web:typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] Runtime tests pass: `npm run test:fast`

#### Manual

- [ ] Settings dialog no longer shows "Git button prompts" section
- [ ] Saving settings works without errors
- [ ] Existing `~/.quarterdeck/config.json` files with template fields don't cause errors on startup (fields are simply ignored as unknown keys)

**Checkpoint**: Verify settings and config are clean before test updates.

---

## Phase 5: Update Tests

### Overview

Fix or remove all tests that reference deleted functionality. This phase is separated because test updates touch many files and are lower risk.

### Changes Required

#### 1. Runtime tests

**File**: `test/runtime/config/runtime-config.test.ts`
- Remove tests for `commitPromptTemplate` / `openPrPromptTemplate` config handling (lines 102-103, 108-109, 292-293, 300-307, 335-336, 362-363)

**File**: `test/runtime/trpc/runtime-api.test.ts`
- Remove template fields from config test fixtures (lines 114-117)

**File**: `test/runtime/terminal/agent-registry.test.ts`
- Remove template fields from test fixtures (lines 27-30)

#### 2. Web UI tests

**File**: `web-ui/src/hooks/use-git-actions.test.tsx`
- Remove or rewrite — keep only tests for remaining git sync/branch/history functionality

**File**: `web-ui/src/hooks/use-review-auto-actions.test.tsx`
- Update to only test `move_to_trash` mode. Remove tests for `"commit"` and `"pr"` auto-review modes.

**File**: `web-ui/src/hooks/use-board-interactions.test.tsx`
- Remove `taskGitActionLoadingByTaskId` and `runAutoReviewGitAction` from test fixtures

**File**: `web-ui/src/components/board-card.test.tsx`
- Remove tests for commit/PR button rendering, click handlers, loading states

**File**: `web-ui/src/components/card-detail-view.test.tsx`
- Remove commit/PR prop threading tests

**File**: `web-ui/src/components/detail-panels/column-context-panel.test.tsx`
- Remove commit/PR prop threading tests

**File**: `web-ui/src/components/runtime-settings-dialog.test.tsx`
- Remove tests for prompt template editing UI (lines 65, 67)

**File**: `web-ui/src/components/quarterdeck-board.test.tsx`
- Remove commit/PR prop tests if present

**File**: `web-ui/src/runtime/use-runtime-config.test.tsx`
- Remove template fields from test fixtures (lines 48-51)

**File**: `web-ui/src/runtime/native-agent.test.ts`
- Remove template fields from test fixtures (lines 40-43)

**File**: `web-ui/src/runtime/use-runtime-project-config.test.tsx`
- Remove template fields from test fixtures (lines 58-61)

### Success Criteria

#### Automated

- [ ] All runtime tests pass: `npm run test`
- [ ] All web UI tests pass: `npm run web:test`
- [ ] Full check passes: `npm run check`
- [ ] Build succeeds: `npm run build`

#### Manual

- [ ] Full app walkthrough: create task, start it, let it reach review, verify no commit/PR buttons, verify auto-trash works, verify settings dialog is clean, verify git history panel still works

---

## Risks

- **Persisted `autoReviewMode` values**: Existing board state JSON may have `autoReviewMode: "commit"` or `"pr"` on cards. Mitigated by `resolveTaskAutoReviewMode` defaulting everything to `"move_to_trash"`. No migration needed.
- **Persisted config with template fields**: `~/.quarterdeck/config.json` may contain `commitPromptTemplate` / `openPrPromptTemplate`. Mitigated by removing them from the TypeScript interface — JSON.parse will include them but TypeScript won't access them. The next config save will not re-write them.
- **Missing a reference**: The deletion touches 20+ files. Mitigated by TypeScript — any dangling reference to a removed prop/export will cause a compile error.

## References

- Planned feature: `docs/planned-features.md` #5
- Related planned feature: #16 (Quick actions menu — potential future replacement)
- Related planned feature: #6 (Server-side commit in diff viewer — real git integration)
- Core files:
  - `web-ui/src/hooks/use-git-actions.ts` — mixed hook, partial removal
  - `web-ui/src/git-actions/build-task-git-action-prompt.ts` — full deletion
  - `web-ui/src/hooks/use-review-auto-actions.ts` — simplification
  - `web-ui/src/components/detail-panels/agent-terminal-panel.tsx:53-97` — `AgentTerminalReviewActions` deletion
  - `web-ui/src/components/board-card.tsx:585-616` — button JSX deletion
  - `web-ui/src/components/runtime-settings-dialog.tsx:602-655` — settings section deletion
  - `src/config/runtime-config.ts:19-20,35-38,47-48,58-89` — config cleanup
  - `src/core/api-contract.ts:558-561,571-572` — API schema cleanup
