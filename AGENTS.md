This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/quarterdeck/utils/react-use`) whenever possible
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui Stack
- Quarterdeck web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

Styling mental model
- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

Design tokens (defined in globals.css @theme)
- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

UI primitives (src/components/ui/)
- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

Icons
- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

Radix UI primitives
- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.
- **Radix AlertDialog `onOpenChange` gotcha**: When using a controlled AlertDialog (`open` + `onOpenChange`), Radix fires `onOpenChange(false)` for ALL close reasons — cancel, confirm action, ESC, and overlay click. This means if `onOpenChange` routes to a cancel handler, it will also fire after confirm. The confirm handler updates state via `setState` (async), so the cancel handler's closure still sees the old state. Fix: use a `useRef` flag — set it synchronously in the confirm handler, check it in the cancel handler, skip the revert if set. See `trashWarningConfirmedRef` in `use-board-interactions.ts` for the reference pattern. This applies to any controlled AlertDialog where confirm and cancel have different side effects.
- **Radix `asChild` requires `forwardRef` + rest props**: Any component passed as a child of a Radix `asChild` trigger (Popover.Trigger, Dialog.Trigger, DropdownMenu.Trigger, etc.) **must** use `React.forwardRef` and spread `...rest` props onto its root DOM element. Radix's internal `Slot` uses `cloneElement` to inject `onClick`, `aria-expanded`, `data-state`, and a `ref` — if the component doesn't forward these, the trigger renders visually but never opens. No error or warning is emitted. See `BranchPillTrigger` in `branch-selector-popover.tsx` for the correct pattern.

Dark theme
- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

Board state single-writer rule
- When the browser UI is connected, the UI is the **single writer** of board state via `saveWorkspaceState` (optimistic concurrency with `expectedRevision`). Server code must **never** call `mutateWorkspaceState` to modify board state for operations triggered while a UI client is active — doing so bumps the server-side revision and causes the UI's next persist to hit a `WorkspaceStateConflictError`, surfacing a disruptive "Workspace changed elsewhere" toast.
- Instead of writing board state from the server, send a lightweight WebSocket message (via `RuntimeStateHub.broadcast*`) with just the data the UI needs, and let the UI apply it to its local board + persist through its normal debounced cycle. See `task_title_updated` as the reference pattern.
- `mutateWorkspaceState` is only safe for CLI-only code paths where no browser UI is connected (e.g. `quarterdeck hooks ingest`, `quarterdeck task` subcommands).

Completing a feature or fix (release hygiene)
- When a todo item is done, **all three files must be updated in the same commit or PR**:
  1. `docs/todo.md` — remove the completed item and renumber remaining items. Update any cross-references (e.g. `#12` → `#11`).
  2. `CHANGELOG.md` — add a bullet under the current version section matching the existing style (feature-area headings, em-dash descriptions). If no current version section exists, create one with the next patch bump.
  3. `docs/implementation-log.md` — add a detailed entry at the top with: what changed, why, which files were touched, and the commit hash. This is the forensic record — include enough detail that someone debugging a regression can understand the full scope of the change without reading the diff.
- Skipping any of these creates drift that compounds quickly across concurrent worktrees. The changelog and implementation log are easy to forget after the code is working — do them immediately, not in a follow-up.
- When bumping the version number, always keep a `## [Unreleased]` section at the top of `CHANGELOG.md` above the new version heading. This is where subsequent changes land before the next release.

Test fixtures and merge conflicts
- Avoid touching test fixture mocks in feature branches — the config mock pattern (adding fields to 10+ test files) is the #1 conflict magnet. If you can defer test fixture updates to a final pass, or extract a shared `createDefaultMockConfig()` helper that all tests import, adding a field becomes a 1-file change instead of 12.

Misc. tribal knowledge
- Quarterdeck is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- When Quarterdeck runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- **Terminal output ≠ agent working.** Agents (especially Claude Code) produce constant incidental terminal output — spinners, status bar updates, prompt redraws, ANSI cursor movements — even while idle or genuinely waiting for user input. Do not use `lastOutputAt` timestamps or output presence/volume as a heuristic for whether an agent has resumed working. The hook system (`to_review` / `to_in_progress`) is the authoritative source for state transitions. If a hook is missed, fix it at the hook layer.
- Two distinct shortcut systems exist — do not confuse them:
  - **Project shortcuts** (`RuntimeProjectShortcut`, `useShortcutActions`): Terminal commands executed in the dev shell via the top bar. Per-project config. Uses `appendNewline: true`.
  - **Prompt shortcuts** (`PromptShortcut`, `usePromptShortcuts`): Agent prompt injection via sidebar review cards. Global config. Uses paste mode + auto-submit.
