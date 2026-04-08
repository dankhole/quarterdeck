# Test Specification: Prompt Shortcuts Dropdown

**Date**: 2026-04-07
**Companion SDD**: [docs/specs/2026-04-07-prompt-shortcuts.md](2026-04-07-prompt-shortcuts.md)
**Adversarial Review Passes**: 3

## Test Strategy

Test the three layers independently: backend config persistence (runtime tests), frontend hook logic (hook tests with HookHarness pattern), and UI rendering (component tests with createRoot/act). The editor dialog gets its own component test. Existing test fixtures that reference `RuntimeConfigState` or `RuntimeConfigResponse` need the new `promptShortcuts` field added.

### Test Infrastructure

- **Framework**: Vitest 4.1.0 with jsdom environment
- **Test directories**: `test/runtime/` (backend), `web-ui/src/**/*.test.tsx` (frontend)
- **Run commands**:
  - All runtime tests: `npm run test`
  - All web UI tests: `npm run web:test`
  - Fast runtime + utility: `npm run test:fast`
  - Full check: `npm run check`
- **CI integration**: `test.yml` runs both runtime and web-ui test suites

### Coverage Goals

- Every SDD requirement has at least one test
- Config persistence round-trip verified
- Hook execution logic (paste+submit) verified
- Dropdown visibility guard verified
- Editor dialog CRUD verified
- Error scenarios covered (paste failure, save failure)
- Existing tests updated to not break on new config fields

## Unit Tests

### Config Persistence (Runtime)

**Test file**: `test/runtime/config/runtime-config.test.ts`
**Pattern to follow**: Existing tests in this file use temporary directories with `mkdtempSync`, `withTemporaryEnv` helper, and direct `loadRuntimeConfig`/`saveRuntimeConfig` calls.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `returns default prompt shortcuts when none configured` | `loadRuntimeConfig` returns `DEFAULT_PROMPT_SHORTCUTS` (one "Commit" entry) when config has no `promptShortcuts` |
| 2 | `persists and loads prompt shortcuts` | Save config with custom prompt shortcuts → reload → get same shortcuts back |
| 3 | `filters invalid prompt shortcuts` | Save config with empty-label and empty-prompt entries → reload → those entries are filtered out |
| 4 | `falls back to defaults when all shortcuts are invalid` | Save config with only invalid entries → reload → get default "Commit" shortcut |
| 5 | `returns defaults when promptShortcuts is not an array` | Write config with `promptShortcuts` set to a string/object/number → reload → get default "Commit" shortcut |

#### Test Details

##### 1. `returns default prompt shortcuts when none configured`

**Setup**: Create temp home/project dirs. Write empty `config.json`. Call `loadRuntimeConfig`.
**Assertions**:
- `state.promptShortcuts` has length 1
- `state.promptShortcuts[0].label` is `"Commit"`
- `state.promptShortcuts[0].prompt` contains `"commit your working changes"`

##### 2. `persists and loads prompt shortcuts`

**Setup**: Create temp dirs. Call `saveRuntimeConfig` with `promptShortcuts: [{ label: "Ship", prompt: "push to main" }, { label: "Fix", prompt: "fix the bug" }]`.
**Key test data**:
- Input: two custom shortcuts
- Expected: persisted in `~/.quarterdeck/config.json`, reloaded identically
**Assertions**:
- Reloaded `state.promptShortcuts` has length 2
- Labels and prompts match input exactly
- Global config JSON file contains `promptShortcuts` array

##### 3. `filters invalid prompt shortcuts`

**Setup**: Manually write config.json with `promptShortcuts: [{ label: "", prompt: "test" }, { label: "Valid", prompt: "" }, { label: "Good", prompt: "real prompt" }]`
**Assertions**:
- Loaded `state.promptShortcuts` has length 1 (only "Good")
- `state.promptShortcuts[0].label` is `"Good"`

##### 4. `falls back to defaults when all shortcuts are invalid`

**Setup**: Write config with `promptShortcuts: [{ label: "", prompt: "" }]`
**Assertions**:
- `state.promptShortcuts` has length 1
- `state.promptShortcuts[0].label` is `"Commit"` (the default)

##### 5. `returns defaults when promptShortcuts is not an array`

**Setup**: Manually write config.json with `promptShortcuts: "not-an-array"` (also test with `promptShortcuts: 42` and `promptShortcuts: { label: "X", prompt: "Y" }` as sub-cases).
**Assertions**:
- `state.promptShortcuts` has length 1
- `state.promptShortcuts[0].label` is `"Commit"` (the default)

---

### usePromptShortcuts Hook

**Test file**: `web-ui/src/hooks/use-prompt-shortcuts.test.tsx` (new file)
**Pattern to follow**: `web-ui/src/hooks/use-shortcut-actions.test.tsx` — HookHarness with `onSnapshot` callback, `createRoot`/`act()`.
**Module mocking**: Mock `saveRuntimeConfig` via `vi.mock("@/runtime/runtime-config-query", ...)` since the hook imports it directly (same pattern as `useShortcutActions`). Also mock `showAppToast` via `vi.mock("@/components/app-toaster", ...)` for toast assertions.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `runs prompt shortcut via paste and submit` | Calls `sendTaskSessionInput` with paste mode, waits, sends `\r` |
| 2 | `shows error toast when paste fails` | Toast shown, `isRunning` reset to false |
| 3 | `updates last used label after successful run` | localStorage updated after execution |
| 4 | `falls back to first shortcut when last used label not found` | `activeShortcut` is first in list when label doesn't match |
| 5 | `saves prompt shortcuts via config` | `saveRuntimeConfig` called with correct payload |
| 6 | `does not fire shortcut when already running` | No duplicate execution when `isRunning` is true |
| 7 | `shows error toast when save fails` | `saveRuntimeConfig` throws → `showAppToast` called with danger intent → returns `false` |
| 8 | `returns false when currentProjectId is null` | `savePromptShortcuts` returns `false` immediately, `saveRuntimeConfig` not called |

#### Test Details

##### 1. `runs prompt shortcut via paste and submit`

**Setup**: HookHarness with `promptShortcuts: [{ label: "Commit", prompt: "do commit" }]`, mock `sendTaskSessionInput` returning `{ ok: true }`.
**Action**: Call `runPromptShortcut("task-1", "Commit")`
**Assertions**:
- `sendTaskSessionInput` called first with `("task-1", "do commit", { appendNewline: false, mode: "paste" })`
- After 200ms delay, called with `("task-1", "\r", { appendNewline: false })`
- `isRunning` is false after completion

##### 2. `shows error toast when paste fails`

**Setup**: Mock `sendTaskSessionInput` returning `{ ok: false, message: "Terminal not connected" }`. Mock `showAppToast` from `@/components/app-toaster` via `vi.mock`.
**Action**: Call `runPromptShortcut("task-1", "Commit")`
**Assertions**:
- `showAppToast` called with `intent: "danger"`, `timeout: 7000`, and message containing "Could not send prompt"
- `sendTaskSessionInput` NOT called a second time (no `\r` sent)
- `isRunning` is false

##### 3. `updates last used label after successful run`

**Setup**: Default shortcuts, mock sendTaskSessionInput success, localStorage initially has `"Commit"`.
**Action**: Call `runPromptShortcut("task-1", "Ship")`
**Assertions**:
- After execution, localStorage key `quarterdeck.prompt-shortcut-last-label` is `"Ship"`

##### 4. `falls back to first shortcut when last used label not found`

**Setup**: `promptShortcuts: [{ label: "A", prompt: "..." }, { label: "B", prompt: "..." }]`, localStorage has `"Deleted"`.
**Assertions**:
- `activeShortcut.label` is `"A"` (first in list)

##### 5. `saves prompt shortcuts via config`

**Setup**: Mock `saveRuntimeConfig` from `@/runtime/runtime-config-query` via `vi.mock("@/runtime/runtime-config-query", ...)`. Provide `refreshRuntimeConfig` in the hook input. Set `currentProjectId` to a workspace path string (e.g. `"/tmp/test-project"`).
**Action**: Call `savePromptShortcuts([{ label: "New", prompt: "new prompt" }])`
**Assertions**:
- `saveRuntimeConfig` called with `("/tmp/test-project", { promptShortcuts: [{ label: "New", prompt: "new prompt" }] })`
- `refreshRuntimeConfig` called after save

##### 6. `does not fire shortcut when already running`

**Setup**: HookHarness with `promptShortcuts: [{ label: "Commit", prompt: "do commit" }]`, mock `sendTaskSessionInput` that returns a promise which does not resolve immediately (use a deferred/pending promise to keep `isRunning` true).
**Action**: Call `runPromptShortcut("task-1", "Commit")`. While it is still running (`isRunning` is true), call `runPromptShortcut("task-1", "Commit")` a second time.
**Assertions**:
- `sendTaskSessionInput` called exactly once (the first invocation) — the second call is a no-op due to the `isRunning` guard

##### 7. `shows error toast when save fails`

**Setup**: HookHarness with `currentProjectId: "/tmp/test-project"`. Mock `saveRuntimeConfig` from `@/runtime/runtime-config-query` to throw an error (e.g. `new Error("Disk full")`). Mock `showAppToast` from `@/components/app-toaster` via `vi.mock`.
**Action**: Call `savePromptShortcuts([{ label: "New", prompt: "new prompt" }])`
**Assertions**:
- `showAppToast` called with `intent: "danger"` and `timeout: 7000`
- Return value is `false`
- `refreshRuntimeConfig` NOT called (error thrown before it)

##### 8. `returns false when currentProjectId is null`

**Setup**: HookHarness with `currentProjectId: null`. Mock `saveRuntimeConfig`.
**Action**: Call `savePromptShortcuts([{ label: "New", prompt: "new prompt" }])`
**Assertions**:
- Return value is `false`
- `saveRuntimeConfig` NOT called
- `refreshRuntimeConfig` NOT called

---

### Prompt Shortcut Editor Dialog

**Test file**: `web-ui/src/components/prompt-shortcut-editor-dialog.test.tsx` (new file)
**Pattern to follow**: `web-ui/src/components/runtime-settings-dialog.test.tsx` — `createRoot`/`act()`, native DOM queries.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `renders existing shortcuts as editable rows` | Each shortcut's label and prompt appear in inputs/textareas |
| 2 | `adds a new shortcut row` | Clicking "Add shortcut" appends an empty row |
| 3 | `deletes a shortcut row` | Clicking delete removes the row |
| 4 | `calls onSave with edited shortcuts` | Save button triggers `onSave` with the current state |
| 5 | `disables save when label is empty` | Save button disabled when any label input is empty |
| 6 | `shows duplicate label validation error` | Inline error shown when two shortcuts have the same label |
| 7 | `shows reminder text about skills` | Helper text mentioning skills and `/commit` is visible |

#### Test Details

##### 1. `renders existing shortcuts as editable rows`

**Setup**: Render with `shortcuts: [{ label: "Commit", prompt: "do commit" }, { label: "Ship", prompt: "ship it" }]`, `open: true`.
**Assertions**:
- Two text inputs with values "Commit" and "Ship"
- Two textareas with values "do commit" and "ship it"

##### 2. `adds a new shortcut row`

**Setup**: Render with one shortcut, open.
**Action**: Click "Add shortcut" button.
**Assertions**:
- Two rows now visible (one existing + one new empty)
- New row has empty label input and empty textarea

##### 3. `deletes a shortcut row`

**Setup**: Render with two shortcuts, open.
**Action**: Click delete button on first row.
**Assertions**:
- One row remains with the second shortcut's data

##### 4. `calls onSave with edited shortcuts`

**Setup**: Render with one shortcut, `onSave` mock. Edit the label input to "Updated".
**Action**: Click Save button.
**Assertions**:
- `onSave` called with `[{ label: "Updated", prompt: "do commit" }]`

##### 5. `disables save when label is empty`

**Setup**: Render with one shortcut. Clear the label input.
**Assertions**:
- Save button has `disabled` attribute

##### 6. `shows duplicate label validation error`

**Setup**: Render with two shortcuts. Set both labels to "Same".
**Assertions**:
- Error text containing "duplicate" is visible in the DOM

##### 7. `shows reminder text about skills`

**Setup**: Render with `open: true`.
**Assertions**:
- DOM contains text matching "skill" (case-insensitive)
- DOM contains text matching "/commit"

---

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 1 | `hides dropdown when no shortcuts configured` | `promptShortcuts` is empty array | No dropdown button rendered | Empty state guard |
| 2 | `handles submit failure after paste success` | Paste OK, `\r` send fails | Error toast shown, prompt text visible in terminal but not submitted | Partial failure path |
| 3 | `does not fire shortcut when already running` | Click main button while `isRunning` is true | Button disabled, no duplicate execution | Debounce guard |

### Edge Case Test Details

#### 1. `hides dropdown when no shortcuts configured`

**Test file**: `web-ui/src/components/board-card.test.tsx` (or inline in existing board-card tests)
**Setup (case A)**: Render `BoardCard` with `columnId: "review"`, `promptShortcuts: []`.
**Setup (case B)**: Render `BoardCard` with `columnId: "review"`, `promptShortcuts` prop omitted (undefined).
**Assertions (both cases)**:
- No element with `aria-label="More prompt shortcuts"` in the DOM

#### 2. `handles submit failure after paste success`

**Test file**: `web-ui/src/hooks/use-prompt-shortcuts.test.tsx`
**Setup**: HookHarness with `promptShortcuts: [{ label: "Commit", prompt: "do commit" }]`. Mock `sendTaskSessionInput` to return `{ ok: true }` on the first call (paste) and `{ ok: false, message: "Terminal disconnected" }` on the second call (`\r` submit).
**Action**: Call `runPromptShortcut("task-1", "Commit")`
**Assertions**:
- `sendTaskSessionInput` called twice (paste succeeded, submit attempted)
- `showAppToast` called with `intent: "danger"`, `timeout: 7000`, and message containing "Could not submit prompt"
- `isRunning` is false after completion

#### 3. `does not fire shortcut when already running`

**Test file**: `web-ui/src/hooks/use-prompt-shortcuts.test.tsx`
**Setup and assertions**: Same as hook test case 6 above (see `does not fire shortcut when already running` in the hook test section).

## Regression Tests

Tests that ensure existing behavior isn't broken by the new implementation.

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 1 | Update `createRuntimeConfigState` fixture | Existing runtime config tests must include `promptShortcuts` in fixtures | `test/runtime/terminal/agent-registry.test.ts:24` |
| 2 | Update `createRuntimeConfigState` fixture | Same for runtime API tests | `test/runtime/trpc/runtime-api.test.ts:111` |
| 3 | Update `RuntimeConfigResponse` fixtures | Web UI tests that mock config response need `promptShortcuts` field | `web-ui/src/runtime/use-runtime-config.test.tsx:45`, `web-ui/src/runtime/native-agent.test.ts:37`, `web-ui/src/hooks/use-home-agent-session.test.tsx:86`, `web-ui/src/hooks/use-startup-onboarding.test.tsx:36`, `web-ui/src/components/runtime-settings-dialog.test.tsx:61` |

## Test Execution Plan

### Phase 1: Backend Config

1. **Write unit tests** for config persistence (tests 1-4 in Config Persistence section)
   - Run: `npm run test:fast` — tests FAIL (no `promptShortcuts` field yet)
2. **Implement Phase 1** (backend config + API contract)
   - Run: `npm run test:fast` — tests PASS
3. **Update regression fixtures** (add `promptShortcuts: []` or `promptShortcuts: [{ label: "Commit", prompt: "..." }]` to all `createRuntimeConfigState` and `createRuntimeConfigResponse` helper functions in existing test files)
   - Run: `npm run test && npm run web:test` — all pass

### Phase 2-3: Hook + Dropdown

1. **Write hook tests** (tests 1-8 in usePromptShortcuts section)
   - Run: `npm run web:test` — tests FAIL
2. **Implement Phase 2** (hook) and **Phase 3** (dropdown UI)
   - Run: `npm run web:test` — tests PASS

### Phase 4: Editor Dialog

1. **Write dialog tests** (tests 1-7 in Editor Dialog section)
   - Run: `npm run web:test` — tests FAIL
2. **Implement Phase 4** (editor dialog)
   - Run: `npm run web:test` — tests PASS

### Commands

```bash
# Run all tests for this feature
npm run check

# Run runtime tests only
npm run test:fast

# Run web UI tests only
npm run web:test

# Run a specific test file
npx --prefix web-ui vitest run src/hooks/use-prompt-shortcuts.test.tsx

# Run with verbose output
npx --prefix web-ui vitest run --reporter=verbose
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Phase 1: Default prompt shortcuts | `returns default prompt shortcuts when none configured` | Unit |
| Phase 1: Config persistence | `persists and loads prompt shortcuts` | Unit |
| Phase 1: Invalid config handling | `filters invalid prompt shortcuts`, `falls back to defaults when all shortcuts are invalid`, `returns defaults when promptShortcuts is not an array` | Unit |
| Phase 1: Frontend config save types | Covered by `saves prompt shortcuts via config` (hook test 5) — exercises the `saveRuntimeConfig` call path | Unit |
| Phase 2: Paste+submit execution | `runs prompt shortcut via paste and submit` | Unit |
| Phase 2: Paste failure | `shows error toast when paste fails` | Unit/Edge |
| Phase 2: Last-used persistence | `updates last used label after successful run` | Unit |
| Phase 2: Label fallback | `falls back to first shortcut when last used label not found` | Unit |
| Phase 2: Config save | `saves prompt shortcuts via config` | Unit |
| Phase 2: Save failure | `shows error toast when save fails` | Unit |
| Phase 2: Null project guard | `returns false when currentProjectId is null` | Unit |
| Phase 3: Visibility guard (empty array) | `hides dropdown when no shortcuts configured` (case A) | Edge |
| Phase 3: Visibility guard (undefined prop) | `hides dropdown when no shortcuts configured` (case B) | Edge |
| Phase 2: Debounce guard | `does not fire shortcut when already running` (hook test 6) | Unit |
| Phase 3: Debounce (UI) | `does not fire shortcut when already running` (edge case 3) | Edge |
| Phase 4: Editor renders | `renders existing shortcuts as editable rows` | Unit |
| Phase 4: Add shortcut | `adds a new shortcut row` | Unit |
| Phase 4: Delete shortcut | `deletes a shortcut row` | Unit |
| Phase 4: Save | `calls onSave with edited shortcuts` | Unit |
| Phase 4: Validation (empty) | `disables save when label is empty` | Unit |
| Phase 4: Validation (duplicate) | `shows duplicate label validation error` | Unit |
| Phase 4: Reminder text | `shows reminder text about skills` | Unit |
| Submit failure after paste success | `handles submit failure after paste success` (edge case 2) | Edge |
| Regression: Config fixtures | Fixture updates across 7 test files | Regression |
