---
project: rename-workspace-to-project
date: 2026-04-17
phase: lessons
---

# Lessons: Rename "workspace" to "project"

## Lesson 1: Bulk sed corrupts test fixtures that contain intentionally old-format data

**What happened:** The build agent used `find | xargs sed` across all `.ts`/`.tsx` files to rename `workspace` → `project`. This was fast (~4900 occurrences across ~290 files), but it blindly replaced strings inside test fixture data that *intentionally* used the old format. The migration test file (`project-state-migration.test.ts`) creates old-format JSON with `"workspaceId"` fields to test migration — sed replaced those with `"projectId"`, breaking 6 tests.

**Root cause:** The bulk sed approach treated test fixture data the same as production code. There was no exclusion list for files whose content is deliberately backward-looking.

**How to avoid:** When doing bulk renames on a codebase with migration logic, identify test files that contain OLD-format fixture data and exclude them from the automated pass. Better yet, run the full test suite immediately after the bulk rename (before moving on to other tasks) so collateral damage surfaces early.

**Severity:** Medium — the handoff doc caught it, but the build agent didn't.

## Lesson 2: Bulk sed misses local variables, parameters, and comments

**What happened:** The build agent's sed patterns targeted file-level type names, function names, and import paths. It missed ~260 remaining `workspace` references: local variables (`workspacesRoot`, `workspaceClients`, `knownWorkspacePath`), property names in interfaces (`onRemovedWorkspace`, `disconnectWorkspaceClients`), comments, error messages, test IDs (`"workspace-1"`), data-testid attributes, toast IDs, and template variables.

**Root cause:** The sed approach was scoped to known patterns rather than being a true find-and-replace-everything pass. Local variable names and inline string literals don't follow predictable patterns.

**How to avoid:** After the bulk sed pass, immediately run a completeness grep to find all remaining occurrences. Budget a follow-up task specifically for the long tail of local renames, and use `replace_all` operations at the file level rather than trying to anticipate every pattern upfront.

## Lesson 3: Rename refactors have cascading type errors from renamed interface members

**What happened:** Renaming a property in an interface (e.g., `onRemovedWorkspace` → `onRemovedProject` in `ProjectRegistry`) doesn't just require changing the definition — every call site passing that property must also be updated. The build agent renamed some definitions but left consumers using the old property names, causing TypeScript errors. Similarly, renaming methods like `broadcastToWorkspace` on a class requires finding every `.broadcastToWorkspace()` call.

**Root cause:** Interfaces and class methods in TypeScript have many implicit consumers. A rename of the definition without a rename of all call sites produces type errors.

**How to avoid:** When renaming interface properties or class methods, grep for the old name across the entire codebase immediately after renaming the definition. Don't rely on the bulk sed pass having caught everything — verify with `npm run typecheck` after each batch of renames.

## Lesson 4: User decision to drop migration was correct

**What happened:** The spec called for an auto-migration function (`migrateWorkspacesToProjects()`) that would run on first launch. The build agent implemented it, but the user decided to drop it in favor of manual migration (4 simple steps: `mv`, edit index.json, move config, rename lockfile). The migration code and tests were deleted.

**Why it was right:** This is a personal project with 3 known installations. Writing, testing, and maintaining backward-compatible migration code for a one-time rename on 3 machines is over-engineering. The manual steps took 30 seconds. The migration tests were the #1 source of build breakage.

**Lesson for forge:** When the spec includes migration/backward-compatibility code, explicitly ask whether the user base justifies the engineering cost. For personal/small-team projects, a manual migration note in the handoff doc is often the right call.

## Lesson 5: The handoff doc was the most valuable forge artifact

**What happened:** The build agent left the codebase in a partially-working state (typecheck passing, tests failing). The handoff doc precisely documented: what was done, what was broken, what remained, and the exact commands to fix each issue. The cleanup pass was fast because the handoff gave exact file names, line numbers, and sed commands.

**Lesson for forge:** When a build phase can't complete cleanly (which is common for large renames), invest in a thorough handoff doc rather than trying to force the build to green. The handoff doc should be structured as a punch list with specific, actionable items — not a narrative description of what went wrong.
