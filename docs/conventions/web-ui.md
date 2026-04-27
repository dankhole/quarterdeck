# Web UI Conventions

> Read this before any frontend work in `web-ui/`.

## Stack

- Quarterdeck web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

## Styling mental model

- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

## Design tokens (defined in globals.css @theme)

- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

## UI primitives (src/components/ui/)

- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

## Icons

- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

## Radix UI primitives

- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.
- **Radix AlertDialog `onOpenChange` gotcha**: When using a controlled AlertDialog (`open` + `onOpenChange`), Radix fires `onOpenChange(false)` for ALL close reasons — cancel, confirm action, ESC, and overlay click. This means if `onOpenChange` routes to a cancel handler, it will also fire after confirm. The confirm handler updates state via `setState` (async), so the cancel handler's closure still sees the old state. Fix: use a `useRef` flag — set it synchronously in the confirm handler, check it in the cancel handler, skip the revert if set. See `trashWarningConfirmedRef` in `use-board-interactions.ts` for the reference pattern. This applies to any controlled AlertDialog where confirm and cancel have different side effects.
- **Radix `asChild` requires `forwardRef` + rest props**: Any component passed as a child of a Radix `asChild` trigger (Popover.Trigger, Dialog.Trigger, DropdownMenu.Trigger, etc.) **must** use `React.forwardRef` and spread `...rest` props onto its root DOM element. Radix's internal `Slot` uses `cloneElement` to inject `onClick`, `aria-expanded`, `data-state`, and a `ref` — if the component doesn't forward these, the trigger renders visually but never opens. No error or warning is emitted. See `BranchPillTrigger` in `branch-selector-popover.tsx` for the correct pattern.

## Dialog suppression ("don't show again")

- Every dialog or confirmation that offers a "don't show again" / "skip this" checkbox **must** have a corresponding toggle in the Settings dialog so the user can re-enable it. Dismissing a dialog permanently must never be a one-way decision.
- Use a config field in `global-config-fields.ts` (not localStorage) so the preference persists across sessions and is centrally manageable.
- Add the re-enable toggle to the **"Suppressed Dialogs"** section at the bottom of Global settings. Existing examples: `showTrashWorktreeNotice`, `skipTaskCheckoutConfirmation`, `skipHomeCheckoutConfirmation`.

## Dark theme

- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

## Hooks architecture

### Directory structure

Hooks live in `src/hooks/` organized by domain. Every hook belongs to a domain subdirectory — the `src/hooks/` root is not a dumping ground for flat files. Current domains:

- `hooks/app/` — app-wide wiring (hotkeys, side effects, action models, layout resize)
- `hooks/board/` — task lifecycle, board state, drag-and-drop, trash workflow
- `hooks/debug/` — debug logging and tooling
- `hooks/git/` — branch operations, diffs, conflict resolution, commit panel
- `hooks/notifications/` — alerts, sound, browser notifications
- `hooks/project/` — project navigation, project switching, sync
- `hooks/search/` — file finder, text search
- `hooks/settings/` — settings form, shortcut actions
- `hooks/terminal/` — PTY panels, shell management, auto-restart

When adding a new hook, place it in the most specific domain that fits. If nothing fits, create a new domain subdirectory rather than leaving it flat.

### Domain modules vs hooks

Separate domain logic from React wiring:

- **Domain module** (`foo-bar.ts`): Pure TypeScript — no React imports, no hooks, no JSX. Exports functions, types, and constants. Testable with plain `describe`/`it` — no `renderHook` needed.
- **Hook** (`use-foo-bar.ts`): Thin React adapter that reads state from context or props, calls domain functions, and writes results back via dispatch or setState.

**When to extract**: if a hook has >50 lines of logic that doesn't reference React APIs (`useState`, `useEffect`, `useCallback`, `useContext`, `useRef`), that logic belongs in a domain module. Good extraction candidates include: validation rules, state machine guards, data transforms, error classification, loading-state derivation, and format/display helpers.

**When NOT to extract**: if the hook is mostly React wiring (event listeners, effect setup, ref management) with minimal domain logic, keep it in one file. Examples: `use-document-visibility`, `use-escape-handler`, `use-app-hotkeys`.

### Naming convention

For a hook at `hooks/{domain}/use-foo-bar.ts`:

```
hooks/board/use-task-lifecycle.ts       ← hook (React wiring)
hooks/board/task-lifecycle.ts           ← domain module (pure TS)
hooks/board/use-task-lifecycle.test.tsx  ← hook integration test (needs renderHook)
hooks/board/task-lifecycle.test.ts      ← domain unit test (no React)
```

The domain module drops the `use-` prefix since it's not a hook.

### Backward-compatible re-exports

When moving types or functions from a hook to a domain module, add re-exports in the hook file so external consumers don't break:

```typescript
// In use-trash-workflow.ts — re-export moved types
export type { HardDeleteDialogState, TrashWarningState } from "@/hooks/board/trash-workflow";
export { INITIAL_HARD_DELETE_DIALOG_STATE, INITIAL_TRASH_WARNING_STATE } from "@/hooks/board/trash-workflow";
```

### Finding existing extractions

For examples of the pattern in the codebase, `ls web-ui/src/hooks/*/` and look for any `*.ts` file that does **not** start with `use-` — those are domain modules paired with their `use-*.ts` hook. Pick the one nearest to the domain you're working in and read both files to see how inputs/outputs are drawn.

### Non-hook files

Utility functions, constants, and React components do not belong in `hooks/`. Place them in `utils/`, `terminal/`, or `components/` respectively.

### Domain barrel files

Each domain subdirectory has an `index.ts` that re-exports its hooks and result types. Consumers import from the domain barrel (`@/hooks/board`) for hooks used across many call sites, and from the specific file (`@/hooks/board/use-task-editor`) when the consumer is tightly coupled to one hook (e.g. a provider that wraps it).

Rules for the barrel:
- Only re-export hooks and their named result/input interfaces. Do not re-export internal domain-module helpers — consumers that need those should import directly from the domain module file.
- Keep entries alphabetized and grouped as `export type { ... }` followed by `export { ... }` per hook.
- Do not add a top-level `src/hooks/index.ts` that re-exports across domains — cross-domain imports must name their domain.
