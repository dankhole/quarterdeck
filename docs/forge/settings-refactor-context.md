# Settings Form Consolidation — Refactor Context

## Branch
`refactor/settings-form-consolidation` (off main, single commit `3822f328`)

## Problem
Adding a new boolean config toggle to the settings dialog required 12 wiring points across 7 files. The save type was hand-duplicated in two web-ui files, the dialog had 26 individual useStates, a 140-line dirty check useMemo, an 80-line reset useEffect, and a manual 27-field save payload object literal. Missing any one point (like the save payload) silently broke persistence.

## What changed

### Eliminated hand-written type duplicates
- `web-ui/src/runtime/runtime-config-query.ts` — replaced 35-field inline type with `RuntimeConfigSaveRequest` import from Zod schema
- `web-ui/src/runtime/use-runtime-config.ts` — replaced two 30+ field inline types (interface + callback) with `RuntimeConfigSaveRequest` import

### Extracted useSettingsForm hook
- **New file**: `web-ui/src/hooks/use-settings-form.ts` (175 lines)
  - `SettingsFormValues` type — defines the 27 fields managed by the form
  - `resolveInitialValues(config, fallbackAgentId)` — single place mapping config to form values
  - `areFormValuesEqual(a, b)` — deep-ish equality matching prior behavior (primitives via `!==`, audibleNotificationEvents field-by-field, shortcuts via `areRuntimeProjectShortcutsEqual`)
  - `useSettingsForm` hook — returns `{ fields, setField, hasUnsavedChanges }`
  - Reset uses JSON.stringify fingerprinting to avoid resetting on config identity-only changes (preserves user edits during polling)

### Refactored runtime-settings-dialog.tsx (-432 lines)
- Removed: 26 config useStates, 40 initialXxx consts, 140-line hasUnsavedChanges useMemo, 80-line reset useEffect, 27-field save payload
- Added: `const { fields, setField, hasUnsavedChanges } = useSettingsForm(config, open, fallbackAgentId)`
- Save payload: `await save(fields)` (one line)
- JSX: `fieldName` → `fields.fieldName`, `setFieldName(v)` → `setField("fieldName", v)`
- Split supportedAgents memo into `orderedAgents` (no form dependency, computes fallbackAgentId) + `supportedAgents` (adds command display using `fields.agentAutonomousModeEnabled`)
- Removed `CONFIG_DEFAULTS` import (moved to hook), removed `areRuntimeProjectShortcutsEqual` import (moved to hook)

### Updated documentation
- `src/config/global-config-fields.ts` — simplified the "add a new field" checklist from 7 steps with 5 sub-steps to 7 flat steps
- `AGENTS.md` — updated "Adding a new config field" section to reflect the simpler flow

## Constraint
Zero behavior drift. The refactor is purely structural — same fields, same defaults, same dirty check logic, same reset timing, same save payload shape.

## Files touched
```
web-ui/src/hooks/use-settings-form.ts          (NEW — 175 lines)
web-ui/src/components/runtime-settings-dialog.tsx  (major refactor, -432 lines)
web-ui/src/runtime/runtime-config-query.ts         (type simplification)
web-ui/src/runtime/use-runtime-config.ts           (type simplification)
src/config/global-config-fields.ts                 (checklist update)
AGENTS.md                                          (checklist update)
```

## Adding a new config field after this refactor
1. `GLOBAL_CONFIG_FIELDS` in `global-config-fields.ts` (1 line)
2. `runtimeConfigResponseSchema` + `runtimeConfigSaveRequestSchema` in `api-contract.ts` (2 lines)
3. `SettingsFormValues` type + `resolveInitialValues()` in `use-settings-form.ts` (2 lines)
4. JSX control in `runtime-settings-dialog.tsx`
5. Consume in `App.tsx` or wherever needed
6. Test fixture in `runtime-config-factory.ts` + `runtime-config.test.ts`

Dirty check, reset, save payload, and web-ui save types are automatic.

## Verification
- `npm run check` (lint + typecheck + 610 tests) — all pass
- `npm run build` — clean
- `npm run web:typecheck` — clean
