# Prompt Shortcuts Dropdown — Implementation Specification

**Date**: 2026-04-07
**Branch**: feature/remove-commit-pr-prompt-injection (builds on top)
**Adversarial Review Passes**: 3
**Test Spec**: [docs/specs/2026-04-07-prompt-shortcuts-tests.md](2026-04-07-prompt-shortcuts-tests.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
"this branch removed the commit and pr buttons and i do want to keep that. i dont want big static buttons with one big config. But im finding myself missing a quick prompt injection button. I want to build something more configurable though. look at how the start task button is a drop down button that stores the last selection. I wanto to have a button like that but for prompt injection. the default button should be commit and it should use the default commit message i have in main now but instead of config in settings, the button should have a a small gear icon and clicking it opens a setting dialog where you can create different shortcuts. giving them a one word name like "commit" and editable text to inject. should have reminder text explaining that you can either put full prompts in or just call user skills. The drop down should obviously let you select between these configured shortcuts. this should only show on task cards in the sidebar view."
-->

## Goal

Add a configurable prompt shortcuts dropdown button to sidebar task cards in the review column. The button fires the last-used shortcut (default: "Commit") into the agent terminal via paste+submit. A dropdown lists all configured shortcuts plus a "Manage shortcuts..." entry that opens an editor dialog. Shortcuts are globally persisted in `~/.quarterdeck/config.json`.

## Behavioral Change Statement

> **BEFORE**: Sidebar task cards in the review column have no prompt injection buttons (commit/PR buttons were removed).
> **AFTER**: Sidebar task cards in the review column display a split dropdown button below the workspace status line. Clicking the main face fires the last-used prompt shortcut (paste + auto-submit into the agent terminal). The chevron opens a dropdown with all shortcuts and a "Manage shortcuts..." row. The editor dialog allows CRUD on named shortcuts with editable prompt text. Ships with a "Commit" default shortcut.
> **SCOPE — all code paths affected**:
> 1. `App.tsx` → `CardDetailView` → `ColumnContextPanel` → `ColumnSection` → `BoardCard` — sidebar review card rendering, insertion point between `reviewBranchLabel` paragraph and `cancelAutomaticActionLabel` block
> 2. `App.tsx` → `usePromptShortcuts` (new hook) — shortcut state + CRUD + execution logic
> 3. `src/config/runtime-config.ts` → `RuntimeGlobalConfigFileShape` — global config persistence for prompt shortcuts
> 4. `src/core/api-contract.ts` — Zod schema for prompt shortcut data flowing through the API
> 5. `src/terminal/agent-registry.ts` → `buildRuntimeConfigResponse` — include prompt shortcuts in config response

*Every implementation phase must trace back to making this change real across ALL paths listed above. If a path is not covered by a phase, the spec has a gap.*

## Current State

- `web-ui/src/components/board-card.tsx:573` — Between the closing `</p>` of the `reviewBranchLabel` paragraph and the `cancelAutomaticActionLabel` conditional block. This is where the old commit/PR buttons lived and where the new dropdown goes.
- `web-ui/src/components/detail-panels/column-context-panel.tsx:184-208` — Sidebar `BoardCard` rendering. Currently passes no prompt injection props.
- `web-ui/src/components/task-create-dialog.tsx:587-644` — Split dropdown pattern (Radix `DropdownMenu`) to follow. Uses `useRawLocalStorageValue` for last-selection persistence.
- `web-ui/src/storage/local-storage-store.ts` — `LocalStorageKey` enum for localStorage keys.
- `web-ui/src/utils/react-use.ts:80-99` — `useRawLocalStorageValue` hook.
- `web-ui/src/hooks/use-board-interactions.ts:227-248` — `handleSendReviewComments`: paste + 200ms delay + `"\r"` submit pattern.
- `src/config/runtime-config.ts:14-19` — `RuntimeGlobalConfigFileShape` for global config.
- `src/core/api-contract.ts:498-503` — Existing `RuntimeProjectShortcut` schema (label, command, icon) — this is for **project-level terminal commands** in the top bar, NOT for agent prompt injection. The new system is separate.
- `web-ui/src/hooks/use-shortcut-actions.ts` — Existing project shortcut execution hook. Sends commands to the **dev shell terminal** with `appendNewline: true`. The new prompt shortcuts send to the **agent session** with paste mode. These are distinct systems.

## Desired End State

- Sidebar review cards show a split dropdown button between the workspace status line and the cancel-auto-action button
- The main button face shows the last-used shortcut name (or "Commit" on first use) and fires it on click
- The chevron opens a Radix dropdown listing all shortcuts plus "Manage shortcuts..." at the bottom
- Selecting a shortcut from the dropdown fires it AND remembers it as the new default
- "Manage shortcuts..." opens a dialog where users can:
  - See all configured prompt shortcuts in an editable list
  - Create new shortcuts with a name and multi-line prompt text
  - Edit existing shortcut names and prompt text
  - Delete shortcuts
  - See reminder text: "Enter a full prompt or just invoke a skill (e.g. `/commit`). The text is pasted into the agent terminal and submitted."
- Ships with one default shortcut: "Commit" with the classic commit prompt template
- Shortcuts persist globally in `~/.quarterdeck/config.json` under a `promptShortcuts` key
- Last-used shortcut label persists in localStorage
- Executing a shortcut: paste prompt text into agent terminal, wait 200ms, send `"\r"`

## Out of Scope

- Board-view cards (only sidebar)
- Agent terminal panel buttons
- Auto-review integration (this is manual-trigger only)
- Template variable interpolation (e.g. `{{base_ref}}`) — raw text only
- Per-project prompt shortcuts (global only)
- Icon picker for prompt shortcuts (keeps it simpler than project shortcuts)
- Keyboard shortcut for prompt shortcuts (e.g. Cmd+Shift+P to fire active shortcut)

## Dependencies

None. Builds on the current branch state where commit/PR buttons are already removed.

## New Dependencies & Configuration

No new packages required.

**Configuration changes:**
- `~/.quarterdeck/config.json` gains a `promptShortcuts` array field
- `localStorage` gains a `quarterdeck.prompt-shortcut-last-label` key

## Architecture & Approach

Follow the existing split dropdown pattern from `task-create-dialog.tsx` and the existing shortcut CRUD pattern from `use-shortcut-actions.ts`, adapted for global config and paste-mode prompt injection.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Separate from project shortcuts | New `promptShortcuts` config field and new hook | Project shortcuts are terminal commands (`appendNewline`); prompt shortcuts are agent prompts (paste mode). Different persistence scope (global vs project). Different execution semantics. | Extend `RuntimeProjectShortcut` with a `mode` field | MUST NOT reuse `RuntimeProjectShortcut` or `useShortcutActions`. MUST add clarifying comments to both systems. |
| Last-used in localStorage | `useRawLocalStorageValue` like start task button | Matches established pattern. Survives page refresh. No server round-trip. | Server-persisted `selectedPromptShortcutLabel` | MUST use `LocalStorageKey` enum, not raw string keys. |
| Global persistence | `~/.quarterdeck/config.json` | User wants same shortcuts across all projects | Per-project config | MUST write to global config only. MUST NOT touch project config. |
| No icon picker | Shortcuts have name + prompt only | Keeps the editor dialog simple. Icons add complexity for little value on a dropdown menu. | Icon picker like project shortcuts | MUST NOT add icon field to prompt shortcut schema. |
| Paste + auto-submit | Same pattern as `handleSendReviewComments` | Matches what the old commit button did. Multi-line prompts need paste mode. | `appendNewline: true` like project shortcuts | MUST use `mode: "paste"` + 200ms + `"\r"`. MUST NOT use `appendNewline`. |

## Interface Contracts

### Prompt Shortcut Schema

```typescript
// In api-contract.ts
export const promptShortcutSchema = z.object({
   label: z.string().min(1).max(30),
   prompt: z.string(),
});
export type PromptShortcut = z.infer<typeof promptShortcutSchema>;
```

### Global Config Shape Addition

```typescript
// In runtime-config.ts, RuntimeGlobalConfigFileShape
interface RuntimeGlobalConfigFileShape {
   // ...existing fields...
   promptShortcuts?: Array<{ label: string; prompt: string }>;
}
```

### RuntimeConfigState Addition

```typescript
// In runtime-config.ts, RuntimeConfigState
export interface RuntimeConfigState {
   // ...existing fields...
   promptShortcuts: PromptShortcut[];
}
```

### RuntimeConfigResponse Addition

```typescript
// In api-contract.ts, runtimeConfigResponseSchema
runtimeConfigResponseSchema = z.object({
   // ...existing fields...
   promptShortcuts: z.array(promptShortcutSchema),
});
```

### RuntimeConfigUpdateInput Addition

```typescript
// In runtime-config.ts
export interface RuntimeConfigUpdateInput {
   // ...existing fields...
   promptShortcuts?: PromptShortcut[];
}
```

### New Hook Interface

> **Save path**: The hook imports `saveRuntimeConfig` directly from `runtime-config-query.ts` (same pattern as `useShortcutActions` at line 4). It does NOT receive a save callback as a prop. The browser save path is: `saveRuntimeConfig` (runtime-config-query.ts) -> tRPC `saveConfig` mutation -> `updateRuntimeConfig` (workspace-scoped) or `updateGlobalRuntimeConfig`. The runtime `saveRuntimeConfig` at line 414 of `runtime-config.ts` is only used for initial CLI config creation and settings dialog full-save, not for incremental updates from hooks.

> **`currentProjectId`**: This is the workspace directory path (e.g. `/Users/me/my-project`), sourced from `useProjectNavigation` in App.tsx. It is passed to `saveRuntimeConfig(workspaceId, ...)` which creates a tRPC client scoped to that workspace. It is NOT a UUID or opaque ID — it is the filesystem path that tRPC uses as `workspacePath`.

```typescript
interface UsePromptShortcutsInput {
   currentProjectId: string | null;
   promptShortcuts: PromptShortcut[];
   refreshRuntimeConfig: () => void;
   sendTaskSessionInput: (
      taskId: string,
      text: string,
      options?: SendTerminalInputOptions,
   ) => Promise<{ ok: boolean; message?: string }>;
}

interface UsePromptShortcutsResult {
   lastUsedLabel: string;
   activeShortcut: PromptShortcut | null;
   isRunning: boolean;
   runPromptShortcut: (taskId: string, shortcutLabel: string) => Promise<void>;
   selectShortcutLabel: (label: string) => void;
   savePromptShortcuts: (shortcuts: PromptShortcut[]) => Promise<boolean>;
}
```

> **Type alignment**: The `RuntimeConfigSaveRequest` Zod-inferred type (from `runtimeConfigSaveRequestSchema`) and `RuntimeConfigUpdateInput` interface must both include the same `promptShortcuts` field. Both paths receive the parsed request directly — the tRPC handler passes the parsed save request to either `updateRuntimeConfig` or `updateGlobalRuntimeConfig`.

### BoardCard New Props

```typescript
// Added to BoardCard props
onRunPromptShortcut?: (taskId: string, shortcutLabel: string) => void;
promptShortcuts?: PromptShortcut[];
lastUsedPromptShortcutLabel?: string;
isPromptShortcutRunning?: boolean;
onManagePromptShortcuts?: () => void;
```

> **No `onSelectPromptShortcutLabel` prop**: The dropdown `onSelect` calls `onRunPromptShortcut` only. Running a shortcut from the dropdown implicitly updates the last-used label (inside `runPromptShortcut`). The `selectShortcutLabel` function on the hook exists only for cases where someone wants to change the default without running — it is not needed in the BoardCard dropdown.

## Implementation Phases

### Phase 1: Backend Config + API Contract

#### Overview

Add prompt shortcut persistence to the global config and expose it through the API contract. No UI changes yet — this is the data layer.

> **Save path clarification**: The browser save path is: `saveRuntimeConfig` (runtime-config-query.ts) -> tRPC `saveConfig` mutation -> `updateRuntimeConfig` (workspace-scoped) or `updateGlobalRuntimeConfig`. The runtime `saveRuntimeConfig` at line 414 of `runtime-config.ts` is only used for initial CLI config creation and settings dialog full-save, not for incremental updates from hooks.

> **Merge pattern**: `promptShortcuts` uses simple array-replace semantics (not the scalar-default merge logic used for `selectedAgentId`, `agentAutonomousModeEnabled`, etc.). When a caller passes `promptShortcuts`, the entire array replaces the previous value. When omitted (`undefined`), the existing value is preserved.

#### Changes Required

##### 1. Add `PromptShortcut` schema to API contract

**File**: `src/core/api-contract.ts`
**Action**: Add
**Location**: After `runtimeProjectShortcutSchema` definition (line 503)
**Changes**:
- Add `promptShortcutSchema` Zod schema: `z.object({ label: z.string().min(1).max(30), prompt: z.string().min(1) })` — the Zod schema is the authoritative validation guard. `normalizePromptShortcuts` serves as a secondary defense for corrupted config JSON that bypasses API validation.
- Export `PromptShortcut` type
- Add `promptShortcuts: z.array(promptShortcutSchema)` to `runtimeConfigResponseSchema` (after `shortcuts` field, around line 555)
- Add `promptShortcuts: z.array(promptShortcutSchema).optional()` to `runtimeConfigSaveRequestSchema` (around line 568)
- Add a comment above `runtimeProjectShortcutSchema`: `/** Project-level terminal command shortcuts (top bar). For agent prompt shortcuts, see promptShortcutSchema. */`
- Add a comment above `promptShortcutSchema`: `/** Global agent prompt injection shortcuts (sidebar review cards). For project terminal commands, see runtimeProjectShortcutSchema. */`

##### 2. Add prompt shortcuts to runtime config persistence

**File**: `src/config/runtime-config.ts`
**Action**: Modify
**Changes**:
- Add `promptShortcuts?: Array<{ label: string; prompt: string }>` to `RuntimeGlobalConfigFileShape` (line 18 area)
- Add `promptShortcuts: PromptShortcut[]` to `RuntimeConfigState` (after `shortcuts`)
- Add `promptShortcuts?: PromptShortcut[]` to `RuntimeConfigUpdateInput` (after `shortcuts`)
- Import `type PromptShortcut` from `api-contract.ts`
- Add `DEFAULT_PROMPT_SHORTCUTS` constant: array with one entry `{ label: "Commit", prompt: "<the old DEFAULT_COMMIT_PROMPT_TEMPLATE>" }`
- Add `normalizePromptShortcuts(shortcuts)` helper: if input is not an array, return `DEFAULT_PROMPT_SHORTCUTS`. Otherwise: trim label and prompt on each entry first, then filter out entries where either label or prompt is empty after trimming. Return `DEFAULT_PROMPT_SHORTCUTS` if the resulting array is empty.
- Update `toRuntimeConfigState` (line 212 area): add `promptShortcuts: normalizePromptShortcuts(globalConfig?.promptShortcuts)`
- Update `writeRuntimeGlobalConfigFile`: add `promptShortcuts?: PromptShortcut[]` to the function parameter type (the inline `config: { ... }` object at line 229). Merge logic (explicit pseudo-code):
  ```
  if (config.promptShortcuts !== undefined) {
     payload.promptShortcuts = config.promptShortcuts;
  } else if (hasOwnKey(existing, "promptShortcuts")) {
     payload.promptShortcuts = existing.promptShortcuts;
  }
  ```
  This follows the same field-by-field merge pattern used for `selectedAgentId`, `selectedShortcutLabel`, etc.
- Update `createRuntimeConfigStateFromValues`: add `promptShortcuts: PromptShortcut[]` to the input type and pass through as `promptShortcuts: normalizePromptShortcuts(input.promptShortcuts)`
- Update `toGlobalRuntimeConfigState`: pass through `promptShortcuts` from `current.promptShortcuts`
- Update `saveRuntimeConfig`: accept and write `promptShortcuts`
- Update `updateRuntimeConfig` (workspace-scoped): add `promptShortcuts: updates.promptShortcuts ?? current.promptShortcuts` to `nextGlobalConfig`. Add `promptShortcuts` array comparison to `hasGlobalChanges` (use JSON.stringify or a dedicated comparison helper). Pass `promptShortcuts` through to `writeRuntimeGlobalConfigFile` and `createRuntimeConfigStateFromValues`. This is the primary save path when a browser UI is connected — the tRPC `saveConfig` mutation routes here.
- Update `updateGlobalRuntimeConfig`: add `promptShortcuts: updates.promptShortcuts ?? current.promptShortcuts` to `nextConfig`. Add `promptShortcuts` array comparison to `hasChanges` (use JSON.stringify or a dedicated comparison helper). Pass `promptShortcuts` to both `writeRuntimeGlobalConfigFile` and `createRuntimeConfigStateFromValues`

##### 3. Add `promptShortcuts` to frontend config save functions

**File**: `web-ui/src/runtime/runtime-config-query.ts`
**Action**: Modify
**Changes**:
- Add `promptShortcuts?: Array<{ label: string; prompt: string }>` to the `nextConfig` inline parameter type of `saveRuntimeConfig` (lines 19-25)

**File**: `web-ui/src/runtime/use-runtime-config.ts`
**Action**: Modify
**Changes**:
- Add `promptShortcuts?: Array<{ label: string; prompt: string }>` to the inline `nextConfig` parameter type of the `save` callback (lines 77-83) and to the matching type in the `UseRuntimeConfigResult` interface (lines 12-17)

##### 4. Include prompt shortcuts in config response

**File**: `src/terminal/agent-registry.ts`
**Action**: Modify
**Location**: `buildRuntimeConfigResponse` function (line 111 area)
**Changes**:
- Add `promptShortcuts: runtimeConfig.promptShortcuts` to the returned object

##### 5. Add CLAUDE.md clarification

**File**: `AGENTS.md`
**Action**: Modify
**Changes**:
- Add a section under "Misc. tribal knowledge":
  ```
  Two distinct shortcut systems exist — do not confuse them:
  - **Project shortcuts** (`RuntimeProjectShortcut`, `useShortcutActions`): Terminal commands executed in the dev shell via the top bar. Per-project config. Uses `appendNewline: true`.
  - **Prompt shortcuts** (`PromptShortcut`, `usePromptShortcuts`): Agent prompt injection via sidebar review cards. Global config. Uses paste mode + auto-submit.
  ```

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] TypeScript compiles: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] Runtime tests pass: `npm run test:fast`

##### Behavioral

- [ ] `loadRuntimeConfig` returns `promptShortcuts` with the default "Commit" entry when no config exists
- [ ] Saving config with `promptShortcuts` persists to `~/.quarterdeck/config.json`
- [ ] Loading config with persisted `promptShortcuts` returns the saved shortcuts

**Checkpoint**: Verify config round-trip works before building UI.

---

### Phase 2: Frontend Hook + Execution Logic

#### Overview

Create `usePromptShortcuts` hook that manages shortcut state, last-used persistence, and the paste+submit execution. No UI yet — just the logic layer.

#### Changes Required

##### 1. Add localStorage key

**File**: `web-ui/src/storage/local-storage-store.ts`
**Action**: Modify
**Changes**:
- Add `PromptShortcutLastLabel = "quarterdeck.prompt-shortcut-last-label"` to `LocalStorageKey` enum

##### 2. Create `usePromptShortcuts` hook

**File**: `web-ui/src/hooks/use-prompt-shortcuts.ts` (new file)
**Action**: Create
**Pattern to follow**: `use-shortcut-actions.ts` for CRUD structure, `use-board-interactions.ts:227-248` for paste+submit execution

**Hook implementation**:

```typescript
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
// ... other imports ...

export function usePromptShortcuts({
   currentProjectId,
   promptShortcuts,
   refreshRuntimeConfig,
   sendTaskSessionInput,
}: UsePromptShortcutsInput): UsePromptShortcutsResult
```

> **Direct import pattern**: The hook imports `saveRuntimeConfig` directly from `runtime-config-query.ts`, matching the pattern used by `useShortcutActions` (line 4 of that file). This avoids prop-threading a save callback.

**Internals**:
- `useRawLocalStorageValue<string>(LocalStorageKey.PromptShortcutLastLabel, "Commit", normalizer)` for last-used label
- `activeShortcut`: derived — find shortcut matching `lastUsedLabel`, fall back to first shortcut, fall back to null
- `isRunning` state (boolean, set during execution). The single-running guard is intentional — it prevents confused UX where multiple paste+submit sequences overlap in the same terminal. This is a deliberate limitation, not a bug.
- `runPromptShortcut(taskId, shortcutLabel)`:
  1. Find shortcut by label
  2. Guard: if `isRunning`, return early (prevents duplicate execution)
  3. Set `isRunning = true`
  4. Call `sendTaskSessionInput(taskId, shortcut.prompt, { appendNewline: false, mode: "paste" })`
  5. On failure: show error toast via `showAppToast` from `@/components/app-toaster` (use `intent: "danger"`, `timeout: 7000`), return
  6. Wait 200ms
  7. Call `sendTaskSessionInput(taskId, "\r", { appendNewline: false })`
  8. On failure: show error toast via `showAppToast` (use `intent: "danger"`, `timeout: 7000`)
  9. Update `lastUsedLabel` to `shortcutLabel`
  10. Set `isRunning = false` (in finally)
- `selectShortcutLabel(label)`: update localStorage value
- `savePromptShortcuts(shortcuts)`:
  1. Guard: if `currentProjectId` is null, return `false` immediately (no workspace context to save against)
  2. Wrap in try/catch:
     - **try**: Call `saveRuntimeConfig(currentProjectId, { promptShortcuts: shortcuts })`. Call `refreshRuntimeConfig()`. Return `true`.
     - **catch**: Show error toast via `showAppToast` from `@/components/app-toaster` (use `intent: "danger"`, `timeout: 7000`). Return `false`.

##### 3. Wire hook into App.tsx

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Changes**:
- Import `usePromptShortcuts`
- Call `usePromptShortcuts` with `currentProjectId`, `runtimeProjectConfig?.promptShortcuts ?? []`, `refreshRuntimeProjectConfig`, `sendTaskSessionInput`
  > **Note**: Despite the variable name `runtimeProjectConfig`, this is the merged `RuntimeConfigResponse` that includes global fields. `promptShortcuts` will be present here after Phase 1 adds it to `runtimeConfigResponseSchema`.
- `sendTaskSessionInput` is destructured from the return value of `useTaskSessions` — see `App.tsx` line 189 where it is already destructured alongside `startTaskSession`, `stopTaskSession`, etc.
- Destructure: `lastUsedPromptShortcutLabel`, `activePromptShortcut`, `isPromptShortcutRunning`, `runPromptShortcut`, `selectPromptShortcutLabel`, `savePromptShortcuts`
- Pass through to `CardDetailView`: `onRunPromptShortcut`, `promptShortcuts`, `lastUsedPromptShortcutLabel`, `isPromptShortcutRunning`, `onManagePromptShortcuts` (opens editor dialog)
  > Note: `onSelectPromptShortcutLabel` is NOT passed to CardDetailView. Running a shortcut from the dropdown already updates the last-used label inside `runPromptShortcut`. The `selectShortcutLabel` function is only exposed on the hook for potential future use.
- Add state for prompt shortcut editor dialog open/close

#### Success Criteria

##### Automated

- [ ] TypeScript compiles: `npm run web:typecheck`
- [ ] Linting passes: `npm run lint`

##### Behavioral

- [ ] Hook can be instantiated without errors (verified via test in Phase 5)

**Checkpoint**: Logic layer complete before building UI components.

---

### Phase 3: Dropdown Button on Sidebar Review Cards

#### Overview

Add the split dropdown button to `BoardCard` and thread props from `App.tsx` through `CardDetailView` → `ColumnContextPanel` → `BoardCard`. Only shows on review-column sidebar cards.

#### Changes Required

##### 1. Add prompt shortcut props to BoardCard

**File**: `web-ui/src/components/board-card.tsx`
**Action**: Modify
**Location**: Inline destructured parameter type (the `}: { ... }` block starting around line 160 — there is no separate named interface) and component body
**Changes**:
- Add the new props to the inline destructured parameter type of the `BoardCard` function: `onRunPromptShortcut`, `promptShortcuts`, `lastUsedPromptShortcutLabel`, `isPromptShortcutRunning`, `onManagePromptShortcuts`
- Add import: `import * as DropdownMenu from "@radix-ui/react-dropdown-menu"`
- Add import: `import { Check, ChevronDown, Settings } from "lucide-react"` (Check for active indicator, Settings for the manage row icon)
- Derive visibility: `const showPromptShortcuts = columnId === "review" && (promptShortcuts?.length ?? 0) > 0 && !isTrashCard`
  > **Double guard (intentional defense in depth)**: `ColumnContextPanel` gates at the data-passing level (only passes prompt shortcut props for review column cards). `BoardCard` guards at the rendering level via `showPromptShortcuts`. This way if either component is reused in a different context, the feature still only appears for review cards.
- Derive active shortcut: find by `lastUsedPromptShortcutLabel` or fall back to first
- Insert JSX between the closing `</p>` of the `reviewBranchLabel` paragraph and the `cancelAutomaticActionLabel` conditional block:

```tsx
{showPromptShortcuts && activeShortcut ? (
   <div className="flex mt-1.5" onMouseDown={stopEvent}>
      <DropdownMenu.Root>
         <div className="inline-flex items-center w-full">
            <Button
               variant="primary"
               size="sm"
               disabled={isPromptShortcutRunning}
               className="flex-1 rounded-r-none"
               onClick={(event) => {
                  stopEvent(event);
                  onRunPromptShortcut?.(card.id, activeShortcut.label);
               }}
            >
               {isPromptShortcutRunning ? "..." : activeShortcut.label}
            </Button>
            <DropdownMenu.Trigger asChild>
               <Button
                  variant="primary"
                  size="sm"
                  disabled={isPromptShortcutRunning}
                  className="rounded-l-none border-l border-white/20 px-1"
                  aria-label="More prompt shortcuts"
                  onMouseDown={stopEvent}
               >
                  <ChevronDown size={12} />
               </Button>
            </DropdownMenu.Trigger>
         </div>
         <DropdownMenu.Portal>
            <DropdownMenu.Content
               side="bottom"
               align="start"
               sideOffset={4}
               className="z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
               onCloseAutoFocus={(event) => event.preventDefault()}
            >
               {promptShortcuts.map((shortcut, index) => (
                  <DropdownMenu.Item
                     key={index}
                     className="flex items-center gap-2 rounded-sm px-2 py-1 text-[12px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3 whitespace-nowrap"
                     onSelect={() => {
                        onRunPromptShortcut?.(card.id, shortcut.label);
                     }}
                  >
                     {shortcut.label === lastUsedPromptShortcutLabel ? (
                        <Check size={12} className="text-accent" />
                     ) : (
                        <span className="w-3" />
                     )}
                     {shortcut.label}
                  </DropdownMenu.Item>
               ))}
               <DropdownMenu.Separator className="my-1 h-px bg-border" />
               <DropdownMenu.Item
                  className="flex items-center gap-2 rounded-sm px-2 py-1 text-[12px] text-text-secondary cursor-pointer outline-none data-[highlighted]:bg-surface-3 whitespace-nowrap"
                  onSelect={() => onManagePromptShortcuts?.()}
               >
                  <Settings size={12} />
                  Manage shortcuts...
               </DropdownMenu.Item>
            </DropdownMenu.Content>
         </DropdownMenu.Portal>
      </DropdownMenu.Root>
   </div>
) : null}
```

**Code Pattern to Follow**: See `task-create-dialog.tsx:587-644` for the split button + dropdown menu styling. Adapt class names: use `w-full` instead of `inline-flex` for the card context (cards are full-width).

##### 2. Thread props through ColumnContextPanel → ColumnSection

**File**: `web-ui/src/components/detail-panels/column-context-panel.tsx`
**Action**: Modify
**Changes**:
- Add prompt shortcut props to `ColumnSection` interface (line 47 area): `onRunPromptShortcut`, `promptShortcuts`, `lastUsedPromptShortcutLabel`, `isPromptShortcutRunning`, `onManagePromptShortcuts`
- Pass these through to `BoardCard` rendering (line 184 area) — only for review column cards
- Add same props to `ColumnContextPanel` interface (line 259 area)
- Pass to `ColumnSection` at line 351 area: `onRunPromptShortcut={column.id === "review" ? onRunPromptShortcut : undefined}` (and same pattern for others)

##### 3. Thread props through CardDetailView

**File**: `web-ui/src/components/card-detail-view.tsx`
**Action**: Modify
**Changes**:
- Add prompt shortcut props to `CardDetailView` interface (line 280 area)
- Pass through to `ColumnContextPanel` at line 653 area

##### 4. Thread props from App.tsx

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Changes**:
- Pass prompt shortcut props to `CardDetailView` rendering (line 1014 area)
- Create `handleRunPromptShortcut` callback that calls `runPromptShortcut(taskId, label)` from the hook

#### Success Criteria

##### Automated

- [ ] TypeScript compiles: `npm run web:typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] Web UI tests pass: `npm run web:test`

##### Manual

- [ ] Sidebar review cards show the split dropdown button with "Commit" label
- [ ] Clicking the main button injects the commit prompt into the agent terminal and submits it
- [ ] Dropdown shows all shortcuts with a check mark on the active one
- [ ] Selecting a different shortcut fires it AND makes it the new default
- [ ] "Manage shortcuts..." appears at the bottom of the dropdown
- [ ] Button does NOT appear on backlog, in_progress, or trash cards
- [ ] Button does NOT appear on board-view cards (only sidebar)

**Checkpoint**: Verify dropdown works before building editor dialog.

---

### Phase 4: Prompt Shortcut Editor Dialog

#### Overview

Build the editor dialog that opens from "Manage shortcuts..." in the dropdown. Allows CRUD on prompt shortcuts.

#### Changes Required

##### 1. Create PromptShortcutEditorDialog component

**File**: `web-ui/src/components/prompt-shortcut-editor-dialog.tsx` (new file)
**Action**: Create
**Pattern to follow**: `runtime-settings-dialog.tsx` for dialog structure, save flow, and styling

**Component interface**:
```typescript
interface PromptShortcutEditorDialogProps {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   shortcuts: PromptShortcut[];
   onSave: (shortcuts: PromptShortcut[]) => Promise<boolean>;
}
```

**Dialog layout**:
- `Dialog` with `DialogHeader title="Prompt Shortcuts"`
- `DialogBody`:
  - Reminder text at top: *"Enter a full prompt or just invoke a skill (e.g. `/commit`). The text is pasted into the agent terminal and submitted."* — styled as `text-text-secondary text-[13px]`
  - Shortcut list — each entry is an editable row:
    - Text input for label (short, e.g. "Commit") — `h-8 w-24` input, `maxLength={30}`
    - Multi-line textarea for prompt text — `rows={3}` resizable
    - Delete button (Trash2 icon) on the right
  - "Add shortcut" button at the bottom (`Plus` icon, `variant="ghost"`)
- `DialogFooter`:
  - Cancel button (`variant="default"`)
  - Save button (`variant="primary"`, disabled when no changes or any label is empty)

**State management**:
- Local `useState` for the editable shortcuts list (cloned from props on open)
- Track `hasUnsavedChanges` by comparing with original
- On Save: call `onSave(editedShortcuts)`. If `onSave` returns `true`, close the dialog. If `onSave` returns `false`, do NOT close — the hook handles error toasting, and the user should be able to retry or fix their input.
- Validate: no empty labels, no empty prompts, no duplicate labels (show inline error)

**Styling tokens**: `bg-surface-2` for inputs, `border-border` for borders, `text-text-primary` for text, standard dialog dimensions

##### 2. Wire dialog into App.tsx

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Changes**:
- Import `PromptShortcutEditorDialog`
- Add `promptShortcutEditorOpen` state (boolean)
- Render `<PromptShortcutEditorDialog>` with `open`, `onOpenChange`, `shortcuts={runtimeProjectConfig?.promptShortcuts ?? []}` (note: `runtimeProjectConfig` is the merged `RuntimeConfigResponse` containing global fields — see Phase 2 note), `onSave={savePromptShortcuts}`
- Set `onManagePromptShortcuts={() => setPromptShortcutEditorOpen(true)}` on the `CardDetailView`

#### Success Criteria

##### Automated

- [ ] TypeScript compiles: `npm run web:typecheck`
- [ ] Linting passes: `npm run lint`

##### Manual

- [ ] "Manage shortcuts..." in dropdown opens the editor dialog
- [ ] Dialog shows existing shortcuts with editable name and prompt text
- [ ] Can add a new shortcut, give it a name and prompt, save
- [ ] Can edit an existing shortcut's name or prompt, save
- [ ] Can delete a shortcut, save
- [ ] Duplicate label names show validation error
- [ ] Empty label or prompt prevents save
- [ ] Reminder text about skills is visible
- [ ] Cancel discards changes
- [ ] After save, the dropdown reflects the updated shortcuts immediately

**Checkpoint**: Full feature complete. Run `npm run check && npm run build`.

---

### Phase 5: Tests

#### Overview

Add tests for the new hook, the config persistence changes, and the editor dialog. Update any existing tests that now fail due to the new config fields.

#### Changes Required

See companion test spec: [docs/specs/2026-04-07-prompt-shortcuts-tests.md](2026-04-07-prompt-shortcuts-tests.md)

#### Success Criteria

##### Automated

- [ ] All runtime tests pass: `npm run test`
- [ ] All web UI tests pass: `npm run web:test`
- [ ] Full check passes: `npm run check`
- [ ] Build succeeds: `npm run build`

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| Prompt paste fails (terminal not connected) | Show error toast "Could not send prompt to the task session." (`timeout: 7000`). Set `isRunning = false`. | Disconnect agent, click shortcut |
| Submit (`\r`) fails after paste succeeds | Show error toast "Could not submit prompt to the task session." (`timeout: 7000`). Set `isRunning = false`. Prompt text is in terminal but not submitted — user can press Enter manually. | Kill terminal mid-execution |
| Config save fails (disk full, permissions) | Show error toast with error message (`timeout: 7000`). Dialog stays open. | Make config file read-only |
| No shortcuts configured (all deleted) | Dropdown button hidden (`showPromptShortcuts` guard). | Delete all shortcuts in editor, save |
| Last-used label doesn't match any shortcut (deleted) | Fall back to first shortcut in the list. | Delete the last-used shortcut |
| Invalid shortcuts in persisted config (empty labels) | `normalizePromptShortcuts` filters them out. Falls back to defaults if all invalid. | Manually edit config.json |

## Rollback Strategy

- **Phase 1 rollback**: Remove `promptShortcuts` from `RuntimeGlobalConfigFileShape`, `RuntimeConfigState`, API contract. Existing `~/.quarterdeck/config.json` files with `promptShortcuts` are harmlessly ignored.
- **Phase 2 rollback**: Delete `use-prompt-shortcuts.ts`, remove imports from `App.tsx`.
- **Phase 3 rollback**: Remove dropdown JSX from `board-card.tsx`, remove props from threading chain.
- **Phase 4 rollback**: Delete `prompt-shortcut-editor-dialog.tsx`, remove dialog from `App.tsx`.
- **Full rollback**: Revert all commits on this branch. No data migration needed — unknown config keys are ignored.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Prop threading adds complexity to already-large component chain | Medium | Low | Props are all optional with `undefined` defaults. Only review column cards exercise the code path. |
| Multi-line prompts break terminal paste | Low | Medium | This is the exact same paste mechanism the old commit button used successfully. The `mode: "paste"` option handles multi-line correctly. |
| Existing tests fail from new config fields | Medium | Low | Phase 5 explicitly updates test fixtures. The new fields are optional with defaults, so most tests won't need changes. |

## Implementation Notes / Gotchas

- The `stopEvent` helper in `board-card.tsx` is critical — without it, click events on the dropdown bubble up and trigger card selection/navigation. The old commit buttons used `stopEvent` on both `onMouseDown` and `onClick`. Do the same for the new dropdown.
- `useRawLocalStorageValue` requires a normalize function as the third argument. For the prompt shortcut label, the normalizer should return the stored string if non-empty, or the default `"Commit"` otherwise.
- When rendering `DropdownMenu` inside `BoardCard`, the portal (`DropdownMenu.Portal`) is essential — without it, the dropdown gets clipped by the card's overflow. The existing pattern in `task-create-dialog.tsx` already uses `Portal`.
- The `onCloseAutoFocus={(event) => event.preventDefault()}` on `DropdownMenu.Content` prevents focus from jumping unexpectedly when the menu closes. Copy this from the existing pattern.
- The sidebar `BoardCard` in `ColumnContextPanel` does NOT receive `onCancelAutomaticAction` — so the cancel button only shows in board view. The prompt shortcut dropdown is the opposite — it only shows in sidebar. This is by design.
- The default "Commit" prompt template (preserved from the old `DEFAULT_COMMIT_PROMPT_TEMPLATE`):
  ```
  When you are finished with the task, commit your working changes.

  First, check your current git state: run `git status` and `git branch --show-current`.

  - If you are on a branch, stage and commit your changes directly on that branch. Write a clear, descriptive commit message that summarizes the changes and their purpose.
  - If you are on a detached HEAD, create a new branch from the current commit first (e.g. `git checkout -b <descriptive-branch-name>`), then stage and commit. Report that a new branch was created.
  - Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
  - Do not cherry-pick, rebase, or push to other branches. Just commit to your current branch.

  Report:
  - Branch name
  - Final commit hash
  - Final commit message
  - Whether a new branch was created (detached HEAD case)
  ```

## References

- **Related files**: `web-ui/src/components/task-create-dialog.tsx:587-644` (split button pattern), `web-ui/src/hooks/use-shortcut-actions.ts` (shortcut CRUD pattern), `web-ui/src/hooks/use-board-interactions.ts:227-248` (paste+submit pattern)
- **Prior art**: Old commit/PR buttons removed in commit `f649a1b`
- **Test Spec**: [docs/specs/2026-04-07-prompt-shortcuts-tests.md](2026-04-07-prompt-shortcuts-tests.md)
