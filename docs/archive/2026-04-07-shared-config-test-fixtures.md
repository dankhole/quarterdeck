# Plan: Shared Config Test Fixtures to Eliminate Merge Conflicts

## Context

Adding a single config field (e.g. `showTrashWorktreeNotice`) currently forces changes to ~18 files. Of those, ~6 are unavoidable logic changes (schema, backend, UI). The other ~10-12 are **test files with copy-pasted config mock factories** — each hardcoding all 27 `RuntimeConfigResponse` fields or all 19 `RuntimeConfigState` fields. When two branches add config fields in parallel, every one of these files conflicts.

The recent trash-confirmation branch hit **17 merge conflicts** when merging main, mostly in these duplicated factories. This plan consolidates them into 2 shared factory files (one per type), reducing future config-field additions from ~12 test-file changes to **1-2 fixture file changes**.

## Key Design Decisions

### Why two factories, not one
- **`RuntimeConfigState`** (backend, 20 fields) — used by 3 backend test files
- **`RuntimeConfigResponse`** (API/frontend, 28 fields including computed `agents`, `detectedCommands`, `effectiveCommand`, `debugModeEnabled`, `llmConfigured`) — used by 7 web-ui test files
- These are different types with different fields. One factory can't serve both.

### Why export defaults from runtime-config.ts
- The default values already exist as private `const`s in `src/config/runtime-config.ts` (lines 92-138)
- Exporting them as a single `DEFAULT_RUNTIME_CONFIG_STATE` object lets the backend test factory import it directly — **single source of truth**, no drift
- The web-ui factory can't import backend code directly (separate build), so it defines its own defaults referencing the Zod schema for type safety

### Why include an agent definition helper
- The `agents` array in `RuntimeConfigResponse` has 7 fields per agent — this is the second-largest chunk of boilerplate in the factories
- Production code computes agents at runtime via `getCuratedDefinitions()` (requires filesystem checks) — tests can't use it
- A `createTestAgentDef(id, overrides?)` helper that pulls labels from `RUNTIME_AGENT_CATALOG` eliminates this duplication

## Implementation

### Step 1: Export default config state from runtime-config.ts

**File:** `src/config/runtime-config.ts`

Add an exported constant that assembles the existing private defaults:

```ts
export const DEFAULT_RUNTIME_CONFIG_STATE: RuntimeConfigState = {
   globalConfigPath: "",
   projectConfigPath: null,
   selectedAgentId: DEFAULT_AGENT_ID,
   selectedShortcutLabel: null,
   agentAutonomousModeEnabled: DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
   readyForReviewNotificationsEnabled: DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
   showSummaryOnCards: DEFAULT_SHOW_SUMMARY_ON_CARDS,
   autoGenerateSummary: DEFAULT_AUTO_GENERATE_SUMMARY,
   summaryStaleAfterSeconds: DEFAULT_SUMMARY_STALE_AFTER_SECONDS,
   showTrashWorktreeNotice: DEFAULT_SHOW_TRASH_WORKTREE_NOTICE,
   audibleNotificationsEnabled: DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED,
   audibleNotificationVolume: DEFAULT_AUDIBLE_NOTIFICATION_VOLUME,
   audibleNotificationEvents: { ...DEFAULT_AUDIBLE_NOTIFICATION_EVENTS },
   audibleNotificationsOnlyWhenHidden: DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN,
   shortcuts: [],
   promptShortcuts: DEFAULT_PROMPT_SHORTCUTS,
   commitPromptTemplate: DEFAULT_COMMIT_PROMPT_TEMPLATE,
   openPrPromptTemplate: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
   commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
   openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
};
```

### Step 2: Create backend test factory

**New file:** `test/utilities/runtime-config-factory.ts`

```ts
import { type RuntimeConfigState } from "../../src/config/runtime-config.js";
import { DEFAULT_RUNTIME_CONFIG_STATE } from "../../src/config/runtime-config.js";

export function createTestRuntimeConfigState(
   overrides: Partial<RuntimeConfigState> = {},
): RuntimeConfigState {
   return {
      ...DEFAULT_RUNTIME_CONFIG_STATE,
      globalConfigPath: "/tmp/global-config.json",
      projectConfigPath: "/tmp/project-config.json",
      ...overrides,
   };
}
```

### Step 3: Create web-ui test factory + agent helper

**New file:** `web-ui/src/test-utils/runtime-config-factory.ts`

```ts
import type { RuntimeConfigResponse, RuntimeAgentDefinition } from "@quarterdeck/quarterdeck";
import { RUNTIME_AGENT_CATALOG } from "@runtime-agent-catalog";

export function createTestAgentDef(
   id: RuntimeAgentDefinition["id"],
   overrides?: Partial<RuntimeAgentDefinition>,
): RuntimeAgentDefinition {
   const catalog = RUNTIME_AGENT_CATALOG.find((e) => e.id === id);
   return {
      id,
      label: catalog?.label ?? id,
      binary: catalog?.binary ?? id,
      command: catalog?.binary ?? id,
      defaultArgs: [],
      installed: true,
      configured: true,
      ...overrides,
   };
}

const DEFAULT_RUNTIME_CONFIG_RESPONSE: RuntimeConfigResponse = {
   selectedAgentId: "claude",
   selectedShortcutLabel: null,
   agentAutonomousModeEnabled: true,
   debugModeEnabled: false,
   effectiveCommand: "claude",
   globalConfigPath: "/tmp/global-config.json",
   projectConfigPath: "/tmp/project/.quarterdeck/config.json",
   readyForReviewNotificationsEnabled: true,
   showTrashWorktreeNotice: true,
   showSummaryOnCards: false,
   autoGenerateSummary: false,
   summaryStaleAfterSeconds: 300,
   llmConfigured: false,
   audibleNotificationsEnabled: true,
   audibleNotificationVolume: 0.7,
   audibleNotificationEvents: { permission: true, review: true, failure: true, completion: true },
   audibleNotificationsOnlyWhenHidden: true,
   commitPromptTemplate: "",
   openPrPromptTemplate: "",
   commitPromptTemplateDefault: "",
   openPrPromptTemplateDefault: "",
   promptShortcuts: [],
   detectedCommands: ["claude"],
   agents: [createTestAgentDef("claude"), createTestAgentDef("codex")],
   shortcuts: [],
};

export function createTestRuntimeConfigResponse(
   overrides: Partial<RuntimeConfigResponse> = {},
): RuntimeConfigResponse {
   return { ...DEFAULT_RUNTIME_CONFIG_RESPONSE, ...overrides };
}
```

### Step 4: Migrate existing test files

Replace each inline factory with an import from the shared factory. Tests that need specific agent configurations or field values pass overrides.

**Backend tests (2 files):**
- `test/runtime/terminal/agent-registry.test.ts` — replace `createRuntimeConfigState()` with import
- `test/runtime/trpc/runtime-api.test.ts` — replace `createRuntimeConfigState()` with import

Note: `test/runtime/config/runtime-config.test.ts` has 3 inline config objects in snapshot assertions but tests real filesystem load/save — leave these as-is since they validate the actual serialization shape.

**Web-UI tests (6 files with full RuntimeConfigResponse factories):**
- `web-ui/src/runtime/use-runtime-config.test.tsx` — `createRuntimeConfigResponse(selectedAgentId)` → import, override `selectedAgentId`
- `web-ui/src/runtime/use-runtime-project-config.test.tsx` — `createRuntimeConfigResponse(selectedAgentId, shortcuts)` → import, override both
- `web-ui/src/runtime/native-agent.test.ts` — `createRuntimeConfigResponse(selectedAgentId, overrides?)` → import, pass `agents` via overrides where needed
- `web-ui/src/hooks/use-startup-onboarding.test.tsx` — `createRuntimeConfigResponse(selectedAgentId)` → import, override `agents` for single-agent scenario
- `web-ui/src/hooks/use-home-agent-session.test.tsx` — `createRuntimeConfig(overrides?)` → import
- `web-ui/src/components/runtime-settings-dialog.test.tsx` — `createSavedConfig(overrides?)` (uses `as unknown as RuntimeConfigResponse` cast) → import, eliminates unsafe cast

Note: `web-ui/src/hooks/use-audible-notifications.test.tsx` does NOT have a config factory — its `defaultProps()` takes individual audio fields as hook props, not a RuntimeConfigResponse. Leave as-is.

For tests that build dynamic agent arrays (e.g. `installed` varies by `selectedAgentId`), use `createTestAgentDef()`:
```ts
createTestRuntimeConfigResponse({
   selectedAgentId: "codex",
   agents: [
      createTestAgentDef("claude", { installed: true, configured: false }),
      createTestAgentDef("codex", { installed: true, configured: true }),
   ],
});
```

### Step 5: Update AGENTS.md

Add a note about using the shared factories when writing new tests that need config mocks.

## Files Modified

| File | Change |
|------|--------|
| `src/config/runtime-config.ts` | Export `DEFAULT_RUNTIME_CONFIG_STATE` |
| `test/utilities/runtime-config-factory.ts` | **New** — backend config factory |
| `web-ui/src/test-utils/runtime-config-factory.ts` | **New** — web-ui config + agent factory |
| `test/runtime/terminal/agent-registry.test.ts` | Replace inline factory with import |
| `test/runtime/trpc/runtime-api.test.ts` | Replace inline factory with import |
| `web-ui/src/runtime/use-runtime-config.test.tsx` | Replace inline factory with import |
| `web-ui/src/runtime/use-runtime-project-config.test.tsx` | Replace inline factory with import |
| `web-ui/src/runtime/native-agent.test.ts` | Replace inline factory with import |
| `web-ui/src/hooks/use-startup-onboarding.test.tsx` | Replace inline factory with import |
| `web-ui/src/hooks/use-home-agent-session.test.tsx` | Replace `createRuntimeConfig()` with import |
| `web-ui/src/components/runtime-settings-dialog.test.tsx` | Replace `createSavedConfig()` with import, remove unsafe cast |
| `AGENTS.md` | Add note about shared config test factories |

## What This Fixes

**Before:** Adding a config field requires updating ~10 test files with hardcoded mock objects. Two parallel branches adding fields = ~17 merge conflicts.

**After:** Adding a config field requires updating 2 fixture files (one per type). Two parallel branches adding fields = ~5 conflicts (the unavoidable logic files), and the fixture files have clean, non-overlapping single-line additions that auto-merge.

## What This Doesn't Fix

- The ~6 core logic files (`runtime-config.ts`, `api-contract.ts`, `agent-registry.ts`, `buildRuntimeConfigResponse()`, settings UI, config hook) still need manual updates per field. That's inherent to the feature — each file has real logic for the field.
- `buildRuntimeConfigResponse()` still manually maps every field. A spread-based approach there would be a separate refactor.

## Verification

1. `npm run test` — all backend tests pass
2. `npm run web:test` — all web-ui tests pass
3. `npm run typecheck && npm run web:typecheck` — both pass
4. `npm run lint` — no new warnings
5. Manually verify: add a dummy field to `DEFAULT_RUNTIME_CONFIG_STATE` and confirm only the fixture files need updating (then revert)
