# Hooks Directory Refactoring Plan

**Goal:** Tame the 78-file flat `web-ui/src/hooks/` directory — first by organizing into domain subdirectories, then by separating domain logic from React wiring, with conventions to prevent re-bloating.

**Status:** Plan documented. No work started.
**Date:** 2026-04-15

---

## Context

The `web-ui/src/hooks/` directory has grown to 78 files (57 hooks, 16 tests, 5 non-hooks) totaling ~17K lines, all flat in one directory. Finding anything requires grep or memorized filenames. There are also 5 files that aren't hooks at all — utility functions, constants, and React components that ended up here by gravity.

The broader problem is structural: React hooks blend domain logic (state machines, validation, data transforms) with UI wiring (`useState`, `useCallback`, `useEffect`). In C# terms, it's as if every service class also inherited from `FrameworkElement` — you can't test the logic without mounting the UI, and you can't read the logic without mentally filtering out lifecycle noise.

This plan has two phases:
- **Phase 1** — Subdirectory reorg (mechanical file moves, no logic changes)
- **Phase 2** — Domain logic extraction (separate "what it does" from "how React consumes it")

Phase 1 is low-risk and can be done in a single session. Phase 2 is incremental and should be done hook-by-hook as files are touched for other work.

### Relationship to other refactors

- **C# readability roadmap** (`docs/refactor-csharp-readability.md` section 8): The App.tsx → providers split created the `providers/` directory and shell providers. The hooks reorg complements that — providers own the wiring, domain modules own the logic, hooks become the glue layer between the two.
- **`docs/web-ui-conventions.md`**: Phase 2 adds a "Hooks architecture" section to codify the conventions.

---

## Table of Contents

1. [Phase 1 — Subdirectory reorganization](#phase-1--subdirectory-reorganization)
2. [Phase 2 — Domain logic extraction](#phase-2--domain-logic-extraction)
3. [Phase 3 — Conventions to prevent re-bloating](#phase-3--conventions-to-prevent-re-bloating)

---

## Phase 1 — Subdirectory reorganization

### Step 1: Relocate non-hook files

Five files in `hooks/` aren't hooks. Move them first to reduce noise before grouping the real hooks.

| File | What it is | Destination |
|------|-----------|-------------|
| `app-utils.tsx` | Pure utility functions (`createIdleTaskSession`, `countTasksByColumn`, URL builders) | `web-ui/src/utils/app-utils.tsx` |
| `session-summary-utils.ts` | Pure utility functions (`selectNewestTaskSessionSummary`) | `web-ui/src/utils/session-summary-utils.ts` |
| `terminal-constants.ts` | Constants (`HOME_TERMINAL_TASK_ID`, `DETAIL_TERMINAL_TASK_PREFIX`) | `web-ui/src/terminal/terminal-constants.ts` |
| `quarterdeck-access-blocked-fallback.tsx` | React component | `web-ui/src/components/quarterdeck-access-blocked-fallback.tsx` |
| `runtime-disconnected-fallback.tsx` | React component | `web-ui/src/components/runtime-disconnected-fallback.tsx` |

**Import updates:** ~10 files import from these. Mechanical find-and-replace.

### Step 2: Group hooks into domain subdirectories

Six subdirectories based on the dependency cluster analysis. Each test file follows its hook.

**`hooks/board/`** — Task lifecycle, board orchestration, drag-and-drop (11 files + tests)

| Hook | Rationale |
|------|-----------|
| `use-board-interactions` | Orchestrator — imports 7 other board hooks |
| `use-board-drag-handler` | Board DnD handling |
| `use-board-metadata-sync` | Syncs board metadata from server |
| `use-task-lifecycle` | Start/stop/trash/restore state machine |
| `use-task-sessions` | Session summary tracking |
| `use-task-start` | Task launch orchestration |
| `use-programmatic-card-moves` | Animate card moves between columns |
| `use-session-column-sync` | Sync card column with session state |
| `use-review-auto-actions` | Auto-actions when task enters review |
| `use-trash-workflow` | Trash confirmation + worktree cleanup |
| `use-linked-backlog-task-actions` | Multi-task linked operations |

**`hooks/git/`** — VCS operations, diffs, conflict resolution (10 files + tests)

| Hook | Rationale |
|------|-----------|
| `use-git-actions` | Primary git operations |
| `use-git-navigation` | File navigation in git views |
| `use-git-view-compare` | Compare view ref selection |
| `use-branch-actions` | Branch CRUD |
| `use-commit-panel` | Commit sidebar state |
| `use-conflict-resolution` | Merge/rebase conflict UI |
| `use-stash-list` | Stash operations |
| `use-diff-comments` | Inline diff comments |
| `use-diff-scroll-sync` | Scroll synchronization between diff panels |
| `use-scope-context` | Scope resolution (task vs home) |

**`hooks/terminal/`** — PTY panels, shell management, migration (5 files + tests)

| Hook | Rationale |
|------|-----------|
| `use-terminal-panels` | Terminal panel lifecycle (orchestrator) |
| `use-terminal-config-sync` | Sync terminal config to server |
| `use-shell-auto-restart` | Restart dead shell sessions |
| `use-migrate-task-dialog` | Task migration confirmation dialog |
| `use-migrate-working-directory` | Working directory migration logic |

**`hooks/project/`** — Workspace and project navigation (8 files + tests)

| Hook | Rationale |
|------|-----------|
| `use-project-navigation` | URL-based project routing |
| `use-project-switch-cleanup` | Reset state on project switch |
| `use-project-ui-state` | Per-project UI preferences |
| `use-workspace-sync` | WebSocket workspace state sync |
| `use-detail-task-navigation` | Task selection via URL params |
| `use-open-workspace` | Workspace picker dialog |
| `use-quarterdeck-access-gate` | License/access gate |
| `use-startup-onboarding` | First-launch onboarding flow |

**`hooks/notifications/`** — Alerts, sound, visibility (5 files + tests)

| Hook | Rationale |
|------|-----------|
| `use-audible-notifications` | Sound notifications |
| `use-review-ready-notifications` | Browser notifications for review state |
| `use-focused-task-notification` | Notification for focused task changes |
| `use-stream-error-handler` | WebSocket error handling + recovery |
| `use-document-visibility` | Page visibility API wrapper |

**Remaining flat in `hooks/`** — Cross-cutting, independent, no natural cluster (14 files + tests)

| Hook | Why it stays flat |
|------|-------------------|
| `use-app-hotkeys` | Global keyboard shortcuts — cross-cutting |
| `use-app-dialogs` | Dialog open/close state — cross-cutting |
| `use-escape-handler` | ESC key handling — cross-cutting |
| `use-navbar-state` | Navbar UI state — cross-cutting |
| `use-settings-form` | Settings dialog form — standalone |
| `use-task-editor` | Task create/edit form — standalone |
| `use-task-title-sync` | Title sync from server — standalone |
| `use-task-branch-options` | Branch dropdown options — standalone |
| `use-task-start-actions` | Task start button logic — standalone |
| `use-prompt-shortcuts` | Agent prompt injection — standalone |
| `use-shortcut-actions` | Terminal command shortcuts — standalone |
| `use-display-summary` | Hover summary display — standalone |
| `use-file-browser-data` | File tree data fetching — standalone |
| `use-debug-logging` | Debug log panel state — standalone |
| `use-debug-tools` | Debug panel actions — standalone |
| `use-title-actions` | Title bar actions — standalone |

### Step 3: Update all imports

123 import sites across the codebase reference `@/hooks/...`. Each moved file needs its imports updated in all consumers.

**No config changes needed.** The `@/*` → `src/*` alias in both `tsconfig.json` and `vite.config.ts` supports arbitrary depth. `@/hooks/board/use-board-interactions` resolves correctly out of the box.

**No barrel files.** Every import stays as a direct file path (`@/hooks/board/use-task-lifecycle`, not `@/hooks/board`). Barrel re-exports add maintenance overhead, hurt tree-shaking clarity, and create a false sense of encapsulation.

### Step 4: Verify

```bash
npm run web:typecheck   # Confirm all imports resolve
npm run web:test        # Confirm no broken test imports
npm run build           # Confirm production build works
```

### Blast radius and timing

- ~123 import sites change across ~40 source files
- Pure file moves + import rewrites — zero logic changes
- **High merge conflict risk** with concurrent worktree work
- Best done when there's low concurrent activity, as a standalone commit with no logic changes

---

## Phase 2 — Domain logic extraction

### The problem in C# terms

A React hook is like a service class that inherits from `FrameworkElement`. The domain logic (state machine, validation, data transforms) is tangled with UI wiring (`useState`, `useCallback`, `useEffect`). You can't unit-test the logic without mounting React, and you can't read the logic without mentally filtering out lifecycle boilerplate.

### The pattern: service module + thin hook

For each hook that contains substantial domain logic, split into two files:

```
hooks/board/use-task-lifecycle.ts        → thin hook (React wiring only)
hooks/board/task-lifecycle.ts            → pure TS module (domain logic)
```

The domain module is a plain TypeScript file — no React imports, no hooks, no JSX. It exports pure functions and type definitions. Think of it as the `ITaskLifecycleService` interface and implementation in C#.

The hook becomes a thin wrapper that:
1. Reads state from React (context, props, refs)
2. Calls domain functions with that state
3. Writes results back to React (dispatch, setState)

### Before (everything in the hook)

```typescript
// hooks/board/use-task-lifecycle.ts — 280 lines
export function useTaskLifecycle(sessions: UseTaskSessionsResult) {
   const dispatch = useBoardDispatch();
   const config = useRuntimeConfig();

   const trashTask = useCallback((taskId: string) => {
      // 40 lines of domain logic:
      // - validate task isn't running
      // - check for linked dependents
      // - build the state mutation
      // - handle worktree cleanup decision
      const task = board.columns.flatMap(c => c.cards).find(c => c.id === taskId);
      if (!task) return;
      const session = sessions.getSession(taskId);
      if (session?.status === "running") {
         toast.error("Stop the session before trashing");
         return;
      }
      const hasWorktree = task.worktreePath != null;
      if (hasWorktree && !config.skipTrashWorktreeNotice) {
         setTrashWarning({ taskId, title: task.title });
         return;
      }
      dispatch({ type: "TRASH_TASK", taskId, deleteWorktree: hasWorktree });
   }, [board, sessions, config, dispatch]);

   // ... 8 more callbacks with similar logic-heavy bodies

   return { trashTask, restoreTask, deleteTask, ... };
}
```

### After (separated)

```typescript
// hooks/board/task-lifecycle.ts — pure domain logic, no React
// (C# equivalent: TaskLifecycleService.cs)

export interface TrashValidation {
   readonly canTrash: boolean;
   readonly blockedReason?: string;
   readonly needsWorktreeConfirmation: boolean;
}

export function validateTrash(
   task: BoardCard | undefined,
   sessionStatus: string | undefined,
): TrashValidation {
   if (!task) return { canTrash: false, blockedReason: "Task not found" };
   if (sessionStatus === "running") {
      return { canTrash: false, blockedReason: "Stop the session before trashing" };
   }
   return {
      canTrash: true,
      needsWorktreeConfirmation: task.worktreePath != null,
   };
}

export function buildTrashAction(taskId: string, deleteWorktree: boolean): BoardAction {
   return { type: "TRASH_TASK", taskId, deleteWorktree };
}
```

```typescript
// hooks/board/use-task-lifecycle.ts — thin React wiring
// (C# equivalent: TaskLifecycleViewModel.cs)

import { validateTrash, buildTrashAction } from "./task-lifecycle";

export function useTaskLifecycle(sessions: UseTaskSessionsResult) {
   const dispatch = useBoardDispatch();
   const config = useRuntimeConfig();
   const board = useBoardState();

   const trashTask = useCallback((taskId: string) => {
      const task = findCard(board, taskId);
      const session = sessions.getSession(taskId);
      const validation = validateTrash(task, session?.status);

      if (!validation.canTrash) {
         toast.error(validation.blockedReason!);
         return;
      }
      if (validation.needsWorktreeConfirmation && !config.skipTrashWorktreeNotice) {
         setTrashWarning({ taskId, title: task!.title });
         return;
      }
      dispatch(buildTrashAction(taskId, validation.needsWorktreeConfirmation));
   }, [board, sessions, config, dispatch]);

   return { trashTask, ... };
}
```

### What this buys you

| Benefit | C# analogy |
|---------|-----------|
| Domain logic is testable with plain `describe`/`it` — no `renderHook`, no React | Unit-testing a service without spinning up the DI container |
| Domain module has zero dependencies on React — portable | Service layer doesn't reference `System.Windows` |
| Hook is a thin adapter — if React's API changes, only the hook changes | ViewModel is the only thing that knows about the UI framework |
| Domain types are explicit and navigable (`TrashValidation`, `BoardAction`) | DTOs and interfaces you can ctrl+click |
| Functions are small and named — each one does one thing | Single-responsibility methods on a service class |

### Which hooks to extract (and which to leave alone)

**Extract** — hooks with substantial domain logic (>50 lines of non-React code):

| Hook | Domain logic to extract |
|------|------------------------|
| `use-task-lifecycle` | Trash/restore validation, state machine guards |
| `use-board-interactions` | Orchestration logic, drag-drop validation |
| `use-conflict-resolution` | Conflict state machine, resolution strategy |
| `use-commit-panel` | Commit validation, message generation |
| `use-workspace-sync` | State reconciliation, revision conflict handling |
| `use-git-actions` | Git command orchestration, error classification |
| `use-task-start` | Start validation, worktree creation logic |
| `use-trash-workflow` | Trash confirmation flow, worktree cleanup decisions |
| `use-terminal-panels` | Panel lifecycle, connection state machine |
| `use-settings-form` | Form validation, config diffing |
| `use-project-navigation` | URL parsing, project resolution |

**Leave as-is** — hooks that are mostly React wiring with minimal domain logic:

| Hook | Why it stays |
|------|-------------|
| `use-document-visibility` | 15-line wrapper around `document.visibilityState` |
| `use-escape-handler` | Pure keyboard event handler |
| `use-display-summary` | Simple hover timeout |
| `use-debug-logging` | State + effect, no domain logic |
| `use-app-hotkeys` | Keyboard shortcut registration |
| `use-diff-scroll-sync` | Scroll position tracking |

### Naming convention

For a hook in `hooks/{domain}/use-foo-bar.ts`, the domain module is `hooks/{domain}/foo-bar.ts` (drop the `use-` prefix, since it's not a hook).

```
hooks/board/use-task-lifecycle.ts   ← hook (React wiring)
hooks/board/task-lifecycle.ts       ← domain module (pure TS)
hooks/board/use-task-lifecycle.test.tsx  ← hook integration test
hooks/board/task-lifecycle.test.ts      ← domain unit test (no React)
```

### Migration strategy

**Do not extract all hooks at once.** Extract incrementally — when you're already modifying a hook for a feature or bugfix, check if it has substantial domain logic. If so, extract it in the same PR. This spreads the work and keeps diffs reviewable.

Priority order for proactive extraction (if doing a dedicated pass):
1. `use-task-lifecycle` — most complex state machine, highest test value
2. `use-conflict-resolution` — complex multi-step flow
3. `use-workspace-sync` — revision conflict logic is non-trivial
4. Everything else — as-encountered

---

## Phase 3 — Conventions to prevent re-bloating

After Phases 1-2 are underway, add the following section to `docs/web-ui-conventions.md`:

### Proposed addition to web-ui-conventions.md

```markdown
## Hooks architecture

### Directory structure

Hooks live in `src/hooks/` organized by domain:

- `hooks/board/` — task lifecycle, board state, drag-and-drop
- `hooks/git/` — branch operations, diffs, conflict resolution
- `hooks/terminal/` — PTY panels, shell management
- `hooks/project/` — workspace navigation, project switching
- `hooks/notifications/` — alerts, sound, browser notifications
- `hooks/` (flat) — cross-cutting hooks that don't belong to a single domain

When adding a new hook, place it in the most specific subdirectory that fits.
Only keep hooks flat at the root if they're genuinely cross-cutting (used by
3+ domains) or standalone utilities.

### Domain modules vs hooks

Separate domain logic from React wiring:

- **Domain module** (`foo-bar.ts`): Pure TypeScript — no React imports, no
  hooks, no JSX. Exports functions, types, and constants. Testable with plain
  `describe`/`it` — no `renderHook` needed.
- **Hook** (`use-foo-bar.ts`): Thin React adapter that reads state from context
  or props, calls domain functions, and writes results back via dispatch or
  setState.

When to extract: if a hook has >50 lines of logic that doesn't reference React
APIs (useState, useEffect, useCallback, useContext, useRef), that logic belongs
in a domain module.

When NOT to extract: if the hook is mostly React wiring (event listeners,
effect setup, ref management) with minimal domain logic, keep it in one file.

### Non-hook files

Utility functions, constants, and React components do not belong in `hooks/`.
Place them in `utils/`, `terminal/`, or `components/` respectively.

### No barrel files

Every import is a direct file path (`@/hooks/board/use-task-lifecycle`).
Do not add `index.ts` barrel re-exports.
```

---

## Execution plan

| Phase | Effort | Risk | When |
|-------|--------|------|------|
| **1 — Subdirectory reorg** | 1-2 hours | Low (mechanical, no logic changes). High merge-conflict risk if done during active worktree work. | Do in a low-activity window as a standalone commit. |
| **2 — Domain extraction** | Incremental | Low per-hook (no behavior change, just file splits). Risk is in getting the React/domain boundary wrong. | Do hook-by-hook as files are touched for other work. Optionally do a focused pass on the 3 priority hooks. |
| **3 — Conventions** | 15 minutes | None | Add to `web-ui-conventions.md` alongside Phase 1. |

### Phase 1 commit message

```
refactor: organize web-ui hooks into domain subdirectories

Move 78 flat files into 5 domain subdirectories (board, git, terminal,
project, notifications) plus relocate 5 misplaced non-hook files.
Pure file moves and import path updates — no logic changes.
```
