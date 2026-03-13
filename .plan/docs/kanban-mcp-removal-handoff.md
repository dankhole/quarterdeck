# Kanban MCP Removal Handoff

Date: 2026-03-13
Context commit: `57b4b34` (`feat: add kanban skill and task CLI workflow`)

## Goal

Remove Kanban MCP end to end because Kanban skills + `kanban task` CLI now replace MCP behavior.

This doc is the compact-resume map of:
- what has already replaced MCP
- every touchpoint to delete or update
- the order to do the cleanup safely

## What already replaced MCP

### Skill-based replacement

- Skill generator and installer:
  - `src/skills/kanban-skill.ts`
- Skill install targets:
  - `~/.agents/skills/kanban/SKILL.md` always
  - `~/.claude/skills/kanban/SKILL.md` when Claude is detected
- Dynamic command prefix support:
  - `kanban`
  - `npx -y kanban`
  - `pnpm dlx kanban`
  - `yarn dlx kanban`
  - `bun x kanban`

### CLI replacement for MCP tools

MCP tools are now represented by these CLI commands:
- `list_tasks` -> `kanban task list`
- `create_task` -> `kanban task create`
- `update_task` -> `kanban task update`
- `link_tasks` -> `kanban task link`
- `unlink_tasks` -> `kanban task unlink`
- `start_task` -> `kanban task start`

Implementation:
- `src/commands/task.ts`

Dispatch wiring:
- `src/cli.ts` (`isTaskSubcommand` / `runTaskSubcommand`)

## Kanban MCP backend touchpoints to remove

### Direct MCP runtime/server code

- `src/mcp/server.ts`
- `src/commands/mcp.ts`
- `src/mcp/task-state.ts` (only re-export wrapper now; can be removed and imports pointed at core)

### CLI wiring

- `src/cli.ts`
  - remove `commands/mcp.ts` import
  - remove `isMcpSubcommand` block
  - remove help text line `npx -y kanban mcp`

### Tests

- `test/runtime/mcp/server.integration.test.ts`
- `test/runtime/mcp/task-state.test.ts` (if `src/mcp/task-state.ts` is removed)

### Dependency

- `package.json`
  - `@modelcontextprotocol/sdk` can be removed only after no imports remain

## Kanban MCP setup prompt/UI touchpoints to remove

### Prompt detection and prompt content

- `web-ui/src/hooks/use-task-start-service-prompts.ts`
  - remove `kanban_mcp` detection branch and install command constants/functions
  - remove `kanban_mcp` branch in `buildTaskStartServicePromptContent`
  - remove `kanbanMcp` check from `isTaskStartServicePromptAlreadyConfigured`
  - remove Kanban do-not-show state and local-storage handling

### Prompt tests

- `web-ui/src/hooks/use-task-start-service-prompts.test.ts`
  - remove Kanban MCP detection/content/config tests
  - keep Linear + GitHub tests

### Telemetry types/tests

- `web-ui/src/telemetry/events.ts`
  - remove `"kanban_mcp"` from `TaskStartSetupKind`
- `web-ui/src/telemetry/events.test.ts`
  - remove/adjust assertions using `"kanban_mcp"`

### Local storage key

- `web-ui/src/storage/local-storage-store.ts`
  - remove `TaskStartKanbanSetupPromptDoNotShowAgain`

## Runtime availability touchpoints to remove

### Backend availability detection

- `src/terminal/task-start-setup-detection.ts`
  - remove `serverName: "linear" | "kanban"` union, keep only `"linear"`
  - remove `kanbanMcp` return field

### API contract

- `src/core/api-contract.ts`
  - `runtimeTaskStartSetupAvailabilitySchema`: remove `kanbanMcp`
  - all impacted types inherit from this

### Runtime config producers/consumers

- `src/terminal/agent-registry.ts` uses `detectTaskStartSetupAvailability`
- web-ui runtime config tests currently include `kanbanMcp` in fixture objects:
  - `web-ui/src/runtime/use-runtime-config.test.tsx`
  - `web-ui/src/runtime/use-runtime-project-config.test.tsx`
  - `test/runtime/terminal/agent-registry.test.ts`

## Docs and messaging touchpoints to remove

- `README.md`
  - remove Kanban MCP setup commands/instructions
  - replace with Kanban skill + `kanban task` usage
- `CHANGELOG.md`
  - remove historical Kanban MCP claims only if desired
  - optional: keep history but avoid present-tense MCP guidance

## Search patterns to verify cleanup

After edits, these should return no Kanban MCP code paths:

```bash
rg -n "kanban_mcp|Kanban MCP|kanban mcp|runKanbanMcpServer|createMcpServer|isMcpSubcommand|runMcpSubcommand" src web-ui test README.md -S
```

If fully removing MCP framework from Kanban runtime:

```bash
rg -n "@modelcontextprotocol/sdk|/mcp/" src test -S
```

## Suggested execution order

1. Remove backend MCP server/subcommand/files and fix imports/tests.
2. Remove Kanban MCP setup prompt path in web-ui + telemetry + local storage.
3. Remove `kanbanMcp` from runtime availability schema and all fixtures/tests.
4. Update README away from Kanban MCP to skills + `kanban task`.
5. Remove now-unused dependency `@modelcontextprotocol/sdk`.
6. Run full check: `npm run check`.

## Risks and gotchas

- `runtimeTaskStartSetupAvailability` shape change will break both backend and web-ui tests until all fixtures are updated.
- If removing `src/mcp/task-state.ts`, ensure `src/commands/task.ts` continues to import from `src/core/task-board-mutations.ts` (already done).
- Pre-commit runs full `npm run check`; partial edits will fail if intermediate type/test states are inconsistent.

