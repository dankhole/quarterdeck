# BoardCard Prop Threading Audit

**Date**: 2026-04-06  
**Context**: The `BoardCard` component is rendered through two independent parent chains. Because all behavior is controlled via optional callback props, a missing prop silently disables features rather than causing errors. This has already caused a bug where the migrate button didn't appear on sidebar cards.

---

## The Two Rendering Paths

### Board path (main columns)
```
App.tsx → QuarterdeckBoard → BoardColumn → BoardCard
```

### Sidebar path (detail panel)
```
App.tsx → CardDetailView → ColumnContextPanel → ColumnSection → BoardCard
```

Both paths originate from `App.tsx` where the callbacks are defined, but each threads props through different intermediate components.

---

## Current Prop Discrepancies

| BoardCard Prop | Board Path | Sidebar Path | Impact |
|---|---|---|---|
| `onCancelAutomaticAction` | Passed | **Missing** | Users can't cancel auto-review/auto-commit from sidebar cards |
| `onDependencyPointerDown` | Passed | Missing | No dependency linking from sidebar (intentional) |
| `onDependencyPointerEnter` | Passed | Missing | No dependency linking from sidebar (intentional) |
| `isDependencySource` | Passed | Missing | No dependency highlight in sidebar (intentional) |
| `isDependencyTarget` | Passed | Missing | No dependency highlight in sidebar (intentional) |
| `isDependencyLinking` | Passed | Missing | No dependency linking state in sidebar (intentional) |

The dependency props are arguably fine to omit from the sidebar — dependency linking is a spatial interaction that only makes sense on the board canvas. But `onCancelAutomaticAction` is a functional gap.

---

## Why This Pattern Is Fragile

1. **Silent failures**: BoardCard uses `{onCallback && <button>}` patterns. A missing prop just hides the UI — no error, no warning, no type error.
2. **Two threading paths to maintain**: Every new callback added to BoardCard must be threaded through *both* parent chains independently. The chains share no common infrastructure.
3. **Deep prop drilling**: The sidebar path passes through 4 layers (App → CardDetailView → ColumnContextPanel → ColumnSection → BoardCard). Each layer must explicitly accept and forward every prop.
4. **No safety net**: TypeScript doesn't flag this because all callbacks are optional (`?`). Both paths type-check fine even when props are missing.

---

## Recommendation: Shared Callback Context

Extract BoardCard's action callbacks into a React context provider, so both paths get the same callbacks without manual threading.

**Rough shape:**

```tsx
// board-card-actions-context.tsx
type BoardCardActions = {
   onStart: (taskId: string) => void
   onCommit: (taskId: string) => void
   onOpenPr: (taskId: string) => void
   onMoveToTrash: (taskId: string) => void
   onRestoreFromTrash: (taskId: string) => void
   onCancelAutomaticAction: (taskId: string) => void
   onRegenerateTitle: (taskId: string) => void
   onUpdateTitle: (taskId: string, title: string) => void
   // loading states
   commitTaskLoadingById: Record<string, boolean>
   openPrTaskLoadingById: Record<string, boolean>
   moveToTrashLoadingById: Record<string, boolean>
}

const BoardCardActionsContext = createContext<BoardCardActions>(...)
```

**Where to provide it:** In `App.tsx`, wrapping both `QuarterdeckBoard` and `CardDetailView`.

**What changes in BoardCard:** Instead of receiving 10+ callback props, it calls `useBoardCardActions()` and gets them from context. The `card.id` is used to bind the task-specific callbacks internally.

**What stays as props:** Layout-specific props like `index`, `columnId`, `selected`, `onClick`, and the dependency-linking props (which are legitimately board-only).

### Benefits
- New callbacks automatically available in both paths — no threading required
- Eliminates the silent-failure class of bugs entirely for shared actions
- Reduces BoardCard's prop surface from ~23 props to ~10
- Intermediate components (BoardColumn, ColumnSection, etc.) no longer need to forward action callbacks

### Tradeoffs
- Adds a context provider (minor complexity)
- BoardCard becomes coupled to the context rather than being purely prop-driven
- Dependency-related props would still need to be passed as props (board-only concern)

---

## Immediate Fix

Thread `onCancelAutomaticAction` through the sidebar path (CardDetailView → ColumnContextPanel → ColumnSection → BoardCard). This is a quick fix for the known functional gap while the context refactor is considered.
