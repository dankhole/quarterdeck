# Config Save Dual Path Problem

## Background

Settings are saved through two nearly identical functions in `src/config/runtime-config.ts`:

- **`updateRuntimeConfig(cwd, updates)`** — used when a workspace/project is selected. Resolves config paths from `cwd`, loads current config from disk, writes both global and project config files.
- **`updateGlobalRuntimeConfig(current, updates)`** — used during onboarding or when no project is selected. Takes the in-memory config state directly, writes only the global config file.

The split was introduced in `48a02576` ("fix: support onboarding and settings without projects") because the no-project path has no `cwd` to resolve config paths from.

## The bug

In `605c9c03` ("feat: auto-restart shell terminals on unexpected exit"), `shellAutoRestartEnabled` was added to `updateGlobalRuntimeConfig`'s `hasChanges` check. The `||` continuation operator was replaced with a `;` (semicolon), silently terminating the expression. Everything after it became a dead standalone expression whose result was discarded.

This meant that changing any of these settings through the global path would not persist:
- promptShortcuts, showSummaryOnCards, autoGenerateSummary, summaryStaleAfterSeconds
- showTrashWorktreeNotice, commitPromptTemplate, openPrPromptTemplate
- audibleNotificationsEnabled, audibleNotificationVolume, audibleNotificationEvents
- audibleNotificationsOnlyWhenHidden, unmergedChangesIndicatorEnabled

Only 5 settings worked: `selectedAgentId`, `selectedShortcutLabel`, `agentAutonomousModeEnabled`, `readyForReviewNotificationsEnabled`, `shellAutoRestartEnabled`.

The bug went unnoticed because the global path is only hit during onboarding (before a project is selected) — most users save settings with a project active, which uses the correct `updateRuntimeConfig` path.

## Root cause

The two functions are ~80-line near-duplicates that must be kept manually in sync. Every new setting requires additions in both `nextConfig`, `hasChanges`, `writeRuntimeGlobalConfigFile`, and `createRuntimeConfigStateFromValues` — four parallel sites per function, eight total. This is a guaranteed source of drift bugs.

## Recommended fix

Extract the shared logic into a single internal function that both paths call. The only actual difference is:

1. **How `current` config is obtained**: from disk (`loadRuntimeConfigLocked(cwd)`) vs passed in directly
2. **Whether project config is written**: `writeRuntimeProjectConfigFile` is only called in the workspace path
3. **Lock scope**: workspace path locks both global + project config files; global path locks only the global file

A refactored shape:

```typescript
async function applyConfigUpdates(options: {
    globalConfigPath: string;
    projectConfigPath: string | null;
    current: RuntimeConfigState;
    updates: RuntimeConfigUpdateInput;
}): Promise<RuntimeConfigState> {
    // Single nextConfig build, single hasChanges check,
    // single writeRuntimeGlobalConfigFile call,
    // conditional writeRuntimeProjectConfigFile
}
```

Both `updateRuntimeConfig` and `updateGlobalRuntimeConfig` become thin wrappers that resolve their inputs and call `applyConfigUpdates` inside their respective lock scopes.
