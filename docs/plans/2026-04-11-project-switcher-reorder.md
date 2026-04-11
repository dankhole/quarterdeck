# Project Switcher Drag-and-Drop Reorder — Implementation Plan

## Overview

Add drag-and-drop reordering to the project switcher sidebar so users can arrange projects in their preferred order. Ordering persists across sessions via the workspace index file. Todo item #26.

## Current State

- Projects are stored in `~/.quarterdeck/workspaces/index.json` as an unordered `Record<string, WorkspaceIndexEntry>` — no ordering field exists (`src/state/workspace-state.ts:50-54`)
- Projects are sorted alphabetically by repo path in two places:
  - Backend: `listWorkspaceIndexEntries()` at `src/state/workspace-state.ts:618`
  - Frontend: `project-navigation-panel.tsx:60` — `[...projects].sort((a, b) => a.path.localeCompare(b.path))`
- `@hello-pangea/dnd` is already used for board card drag-and-drop in `board-column.tsx` / `board-card.tsx`
- The `reorder()` utility in `web-ui/src/state/board-state.ts:37-44` is a generic array reorder function
- Project mutations follow the pattern: Zod schema (`api-contract.ts`) → tRPC route (`app-router.ts`) → implementation (`projects-api.ts`) → frontend call via `getRuntimeTrpcClient()` in `use-project-navigation.ts`
- After mutations, the server broadcasts `projects_updated` via `RuntimeStateHub`, and the frontend reducer replaces the entire `projects` array

## Desired End State

- Users can drag projects by a grip handle to reorder them in the sidebar
- Ordering is persisted in `index.json` and survives server restarts and page reloads
- Newly added projects appear at the end of the list
- Removing a project cleans up its position in the order array
- With ≤1 project, drag handles are hidden (no-op)

## Out of Scope

- Keyboard-only reordering (arrow keys to move projects up/down) — potential follow-up
- Drag-and-drop between multiple browser tabs (single-client reorder only)
- Project grouping or folders

## Dependencies

None. All required packages (`@hello-pangea/dnd`, `lucide-react` for grip icon) are already installed.

## Implementation Approach

Store an ordered array of workspace IDs (`projectOrder: string[]`) in the existing workspace index file. The backend uses this array as the source-of-truth for project ordering. The frontend receives projects pre-sorted from the server, renders them with `@hello-pangea/dnd` drag-and-drop using a grip handle, and calls a new `projects.reorder` tRPC mutation on drop.

This approach was chosen over alternatives (separate config file, frontend-only localStorage ordering) because:
- Co-locates ordering with the project registry — one file, one lock
- Server-authoritative ordering means all connected clients see the same order
- Follows the existing mutation → broadcast → reducer pattern

---

## Phase 1: Backend Persistence & API

### Overview

Add the `projectOrder` field to the workspace index, update sorting logic, and expose a new `projects.reorder` tRPC mutation.

### Changes Required

#### 1. Workspace index schema — add `projectOrder`

**File**: `src/state/workspace-state.ts`

- Add `projectOrder?: string[]` to `WorkspaceIndexFile` interface (line 50-54)
- Add `projectOrder` to `workspaceIndexFileSchema` as `z.array(z.string()).optional().default([])` — this makes existing index files forward-compatible without migration
- Update `createEmptyWorkspaceIndex()` (line 152-158) to include `projectOrder: []`

#### 2. Sorting logic — respect custom order

**File**: `src/state/workspace-state.ts`

- Update `listWorkspaceIndexEntries()` (line 611-618) to accept and return the `projectOrder` from the index
- New export: `listWorkspaceIndexEntriesOrdered()` that sorts entries by `projectOrder` position, appending unmatched entries alphabetically at the end
- Keep the existing `listWorkspaceIndexEntries()` signature unchanged for callers that don't need ordering

#### 3. New persistence function — update project order

**File**: `src/state/workspace-state.ts`

- New export: `updateProjectOrder(orderedIds: string[]): Promise<void>`
  - Acquires the index lock via `lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), ...)`
  - Reads current index, validates all IDs in `orderedIds` exist in `index.entries`
  - Filters out any IDs that don't exist (defensive — project may have been removed concurrently)
  - Sets `index.projectOrder = orderedIds`, writes via `writeWorkspaceIndex()`

#### 4. Clean up order on project removal

**File**: `src/state/workspace-state.ts`

- Update `removeWorkspaceIndexEntry()` (line 621-633) to also filter the removed ID out of `projectOrder`

#### 5. Zod schemas for reorder request/response

**File**: `src/core/api-contract.ts`

- Add schemas after the existing project remove schemas (~line 503):

```typescript
export const runtimeProjectReorderRequestSchema = z.object({
	projectOrder: z.array(z.string()),
});
export type RuntimeProjectReorderRequest = z.infer<typeof runtimeProjectReorderRequestSchema>;

export const runtimeProjectReorderResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectReorderResponse = z.infer<typeof runtimeProjectReorderResponseSchema>;
```

#### 6. Input validation

**File**: `src/core/api-validation.ts`

- Add `parseProjectReorderRequest()` following the pattern of `parseProjectRemoveRequest()` (line 114-122)
- Validate array is non-empty and all entries are non-empty trimmed strings

#### 7. tRPC route

**File**: `src/trpc/app-router.ts`

- Add `reorder` mutation to the `projects` router (after `remove`, ~line 617):

```typescript
reorder: t.procedure
	.input(runtimeProjectReorderRequestSchema)
	.output(runtimeProjectReorderResponseSchema)
	.mutation(async ({ ctx, input }) => {
		return await ctx.projectsApi.reorderProjects(ctx.requestedWorkspaceId, input);
	}),
```

#### 8. Projects API implementation

**File**: `src/trpc/projects-api.ts`

- Add `reorderProjects` to the `createProjectsApi` return object and `CreateProjectsApiDependencies` interface
- Implementation calls `updateProjectOrder()` from workspace-state, then broadcasts `projects_updated`

#### 9. Workspace registry — respect order in `buildProjectsPayload`

**File**: `src/server/workspace-registry.ts`

- Update `buildProjectsPayload()` (line 329-354) to call the new ordered listing function instead of `listWorkspaceIndexEntries()`, so projects arrive at the frontend in the user's custom order

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Existing tests pass: `npm run test`

#### Manual

- [ ] Existing index files without `projectOrder` load without error (backward compat)
- [ ] Projects still appear in the UI (verify no regression in project listing)

**Checkpoint**: Pause here — backend is complete, but no UI changes yet. Verify with manual testing that the server starts and projects still load.

---

## Phase 2: Frontend Drag-and-Drop

### Overview

Add `DragDropContext`/`Droppable`/`Draggable` to the project list with a grip handle on each row. Wire the drop handler to call the new `projects.reorder` mutation.

### Changes Required

#### 1. Project navigation hook — add reorder handler

**File**: `web-ui/src/hooks/use-project-navigation.ts`

- Add `handleReorderProjects` callback:
  ```typescript
  const handleReorderProjects = useCallback(async (projectOrder: string[]) => {
  	try {
  		const trpcClient = getRuntimeTrpcClient(currentProjectId);
  		const result = await trpcClient.projects.reorder.mutate({ projectOrder });
  		if (!result.ok) {
  			throw new Error(result.error ?? "Could not reorder projects.");
  		}
  	} catch (error) {
  		const message = error instanceof Error ? error.message : String(error);
  		notifyError(message);
  	}
  }, [currentProjectId]);
  ```
- Add to `UseProjectNavigationResult` interface and return object

#### 2. Thread callback through App.tsx

**File**: `web-ui/src/App.tsx`

- Pass `onReorderProjects={handleReorderProjects}` to `<ProjectNavigationPanel>` (around line 1326-1343)

#### 3. Project navigation panel — add DnD

**File**: `web-ui/src/components/project-navigation-panel.tsx`

- Add `onReorderProjects: (projectIds: string[]) => Promise<void>` to component props
- **Remove** the alphabetical sort on line 60 — ordering is now server-authoritative
- Import `DragDropContext`, `Droppable`, `Draggable` from `@hello-pangea/dnd`
- Import `GripVertical` from `lucide-react` for the drag handle icon
- Wrap the project list in `DragDropContext` + `Droppable`:
  ```tsx
  <DragDropContext onDragEnd={handleDragEnd}>
  	<Droppable droppableId="project-list">
  		{(provided) => (
  			<div ref={provided.innerRef} {...provided.droppableProps}>
  				{projects.map((project, index) => (
  					<Draggable key={project.id} draggableId={project.id} index={index}>
  						{(provided, snapshot) => (
  							<div ref={provided.innerRef} {...provided.draggableProps}>
  								<ProjectRow
  									project={project}
  									dragHandleProps={provided.dragHandleProps}
  									isDragging={snapshot.isDragging}
  									{...otherProps}
  								/>
  							</div>
  						)}
  					</Draggable>
  				))}
  				{provided.placeholder}
  			</div>
  		)}
  	</Droppable>
  </DragDropContext>
  ```
- `handleDragEnd` callback:
  - If no destination or same position, return early
  - Reorder the projects array locally (using `Array.from` + splice pattern)
  - Call `onReorderProjects` with the new ID order
- The `DragDropContext` must be a **separate** context from the board's existing one — they are in different component trees so this is natural

#### 4. ProjectRow — accept drag handle props

**File**: `web-ui/src/components/project-navigation-panel.tsx`

- Add `dragHandleProps` and `isDragging` props to `ProjectRow`
- Add a grip handle element that receives `dragHandleProps`:
  ```tsx
  <div
  	{...dragHandleProps}
  	className="shrink-0 cursor-grab text-text-tertiary hover:text-text-secondary opacity-0 group-hover:opacity-100"
  >
  	<GripVertical size={14} />
  </div>
  ```
- The grip handle should be visible on hover (use `group` / `group-hover` on the row container)
- When `isDragging`, apply elevated styling (`shadow-lg`, slightly different background)
- When there are ≤1 projects, hide the grip handle (no point in dragging)

### Success Criteria

#### Automated

- [ ] Type checks pass: `npm run typecheck && npm run web:typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] All tests pass: `npm run test && npm run web:test`
- [ ] Build succeeds: `npm run build`

#### Manual

- [ ] Grip handle appears on hover over project rows
- [ ] Dragging from the grip handle reorders the project list
- [ ] Clicking the project row (not the grip) still navigates to the project
- [ ] After reorder, refreshing the page shows the same order
- [ ] After reorder, opening a new browser tab shows the same order
- [ ] Reordering works smoothly with 5+ projects
- [ ] With 1 project, no grip handle is shown

**Checkpoint**: Core feature is complete. Verify with manual UI testing in the browser.

---

## Phase 3: Edge Cases & Polish

### Overview

Handle edge cases around project add/remove interactions with ordering, and polish the drag experience.

### Changes Required

#### 1. New projects append to end of order

**File**: `src/state/workspace-state.ts`

- In `ensureWorkspaceEntry()` (line 382-420), when a new entry is created (`changed: true`), also append the new workspace ID to `projectOrder`
- This ensures newly added projects appear at the bottom, not inserted alphabetically

#### 2. "Add Project" button position during drag

**File**: `web-ui/src/components/project-navigation-panel.tsx`

- The "Add Project" button sits below the project list — it should remain outside the `Droppable` area so it doesn't get displaced during drag
- Verify it renders after `provided.placeholder` but outside the droppable div

#### 3. Drag visual polish

**File**: `web-ui/src/components/project-navigation-panel.tsx`

- During drag, the dragged row should have `shadow-lg` and a slightly elevated background
- The drop target area should have subtle visual feedback (the `Droppable` snapshot's `isDraggingOver`)
- Ensure the dragged item renders correctly via portal (like board cards do in `board-card.tsx`) to avoid clipping by the scrollable container

### Success Criteria

#### Automated

- [ ] Full check passes: `npm run check`
- [ ] Build passes: `npm run build`

#### Manual

- [ ] Adding a new project places it at the bottom of the list (not re-sorted alphabetically)
- [ ] Removing a project from the middle doesn't shift other projects' relative order
- [ ] "Add Project" button stays in place during drag
- [ ] Dragged project row has elevated shadow and doesn't clip behind the scroll container
- [ ] The `projects_updated` broadcast after reorder doesn't cause unnecessary UI flicker

---

## Risks

- **Concurrent reorder from multiple tabs**: Two browser tabs could submit conflicting reorders. The index file lock serializes writes, so the last write wins. This is acceptable — the same behavior applies to project add/remove today. The losing tab will receive a `projects_updated` broadcast with the final order.
- **Large project lists**: `@hello-pangea/dnd` handles lists of 50+ items well. Project count is unlikely to exceed ~20, so no performance concern.
- **Existing index files without `projectOrder`**: The Zod schema uses `.optional().default([])`, so existing files parse fine. Empty `projectOrder` falls back to alphabetical sort.

## References

- Todo: `docs/todo.md` #26
- Existing DnD pattern: `web-ui/src/components/board-column.tsx`, `web-ui/src/components/board-card.tsx`
- Reorder utility: `web-ui/src/state/board-state.ts:37-44`
- Workspace index: `src/state/workspace-state.ts:50-54` (schema), `src/state/workspace-state.ts:611-618` (listing)
- Project mutations: `src/trpc/app-router.ts:600-619`, `src/trpc/projects-api.ts`
- Frontend hook: `web-ui/src/hooks/use-project-navigation.ts`
- UI component: `web-ui/src/components/project-navigation-panel.tsx`
