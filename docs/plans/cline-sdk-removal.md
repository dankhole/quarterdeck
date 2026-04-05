# Cline SDK Removal Plan

## Goal

Remove all `@clinebot/*` SDK packages and the native chat integration. Cline reverts to a standard PTY-backed CLI agent like Claude, Codex, Droid, etc. — detected by binary on PATH, launched as a terminal process.

## Scope Summary

| Category | Count | Action |
|---|---|---|
| `src/cline-sdk/` source files | 17 | Delete all |
| `@clinebot/*` npm deps | 4 | Remove from package.json |
| Backend test files | 5 | Delete all |
| Frontend Cline components | ~17 | Delete all |
| Frontend Cline hooks | ~10 | Delete all |
| tRPC Cline procedures | 13 | Delete from router |
| API contract Cline types | ~50 types | Delete |
| API validation Cline parsers | ~7 | Delete |
| Integration points in shared files | ~12 files | Edit to remove Cline branching |

## Phase 1: Remove backend SDK integration

### Delete entirely

- `src/cline-sdk/` (all 17 files):
  - `cline-context-overflow-compaction.ts`
  - `cline-event-adapter.ts`
  - `cline-mcp-runtime-service.ts`
  - `cline-mcp-settings-service.ts`
  - `cline-message-repository.ts`
  - `cline-provider-service.ts`
  - `cline-runtime-logger.ts`
  - `cline-runtime-setup.ts`
  - `cline-session-runtime.ts`
  - `cline-session-state.ts`
  - `cline-slash-commands.ts`
  - `cline-task-session-service.ts`
  - `cline-telemetry-service.ts`
  - `cline-tool-call-display.ts`
  - `cline-watcher-registry.ts`
  - `sdk-provider-boundary.ts`
  - `sdk-runtime-boundary.ts`
- `test/runtime/cline-sdk/` (all 5 test files):
  - `cline-task-session-service.test.ts`
  - `cline-session-runtime.test.ts`
  - `cline-message-repository.test.ts`
  - `cline-mcp-runtime-service.test.ts`
  - `cline-event-adapter.test.ts`

### Edit shared backend files

**`src/server/runtime-server.ts`:**
- Remove `clineTaskSessionServiceByWorkspaceId` map, its creation, disposal, and the `getScopedClineTaskSessionService` getter
- Remove `createClineWatcherRegistry()` call
- Stop passing Cline service getters to API factories

**`src/server/runtime-state-hub.ts`:**
- Remove `ClineTaskSessionService` tracking per workspace
- Remove `cline_session_context_updated` and `mcp_auth_updated` stream message types
- Remove `broadcastTaskChatMessage` and related Cline streaming logic

**`src/trpc/runtime-api.ts`:**
- Remove all 6 Cline SDK imports
- Remove `clineProviderService`, `clineMcpSettingsService`, `clineMcpRuntimeService` creation
- Remove all handlers that delegate to Cline services (provider models, OAuth, MCP, chat messages, slash commands)
- Remove `getScopedClineTaskSessionService` dependency parameter

**`src/trpc/workspace-api.ts`:**
- Remove `ClineTaskSessionService` type import and usage
- Remove chat message retrieval that routes through Cline session service

**`src/trpc/app-router.ts`:**
- Delete all 13 Cline-specific procedures:
  - `saveClineProviderSettings`
  - `addClineProvider`
  - `updateClineProvider`
  - `getClineSlashCommands`
  - `getClineProviderCatalog`
  - `getClineAccountProfile`
  - `getClineKanbanAccess`
  - `getClineProviderModels`
  - `runClineProviderOAuthLogin`
  - `getClineMcpAuthStatuses`
  - `runClineMcpServerOAuth`
  - `getClineMcpSettings`
  - `saveClineMcpSettings`

**`src/cli.ts`:**
- Remove `disposeCliTelemetryService` import from cline-sdk

**`src/terminal/agent-registry.ts`:**
- Remove `isNativeCline = agent.id === "cline"` special case (line 69) — Cline becomes binary-gated like all other agents
- Remove empty-string return for Cline in `buildDisplayedAgentCommand` (lines 58-59)
- Remove `RuntimeClineProviderSettings` from `buildRuntimeConfigResponse` signature and response

**`src/config/runtime-config.ts`:**
- Change `DEFAULT_AGENT_ID` from `"cline"` to `"claude"` (line 56) — Cline will need a CLI install to be usable, so Claude is a better default

## Phase 2: Remove API contract and validation types

**`src/core/api-contract.ts`:**
- Delete all ~50 Cline-specific type definitions (lines ~299-786):
  - `RuntimeClineMcpServerAuthStatus` and schema
  - `RuntimeClineProviderSettings` and schema
  - `RuntimeClineProviderModel` and schema
  - `RuntimeClineMcpServer` and schema
  - `RuntimeClineOauthProvider` and schema
  - `RuntimeClineReasoningEffort` and schema
  - All MCP, OAuth, provider catalog, and account profile schemas and types
- Remove `clineSessionContextVersion` from workspace state schema (line 314)
- Remove `cline_session_context_updated` and `mcp_auth_updated` from stream message union (lines 379-404)
- Remove `clineProviderSettings` from `RuntimeConfigResponse` (line 785)

**`src/core/api-validation.ts`:**
- Delete all Cline parser functions:
  - `parseClineAddProviderRequest`
  - `parseClineMcpOAuthRequest`
  - `parseClineMcpSettingsSaveRequest`
  - `parseClineOauthLoginRequest`
  - `parseClineProviderModelsRequest`
  - `parseClineProviderSettingsSaveRequest`
  - `parseClineUpdateProviderRequest`

## Phase 3: Remove frontend Cline-specific files

### Delete entirely — components

- `web-ui/src/components/detail-panels/cline-agent-chat-panel.tsx` + `.test.tsx`
- `web-ui/src/components/detail-panels/cline-chat-composer.tsx`
- `web-ui/src/components/detail-panels/cline-chat-composer-completion.ts` + `.test.ts`
- `web-ui/src/components/detail-panels/cline-chat-message-item.tsx`
- `web-ui/src/components/detail-panels/cline-chat-message-utils.ts` + `.test.ts`
- `web-ui/src/components/detail-panels/cline-chat-model-selector.tsx` + `.test.tsx`
- `web-ui/src/components/detail-panels/cline-model-picker-options.ts` + `.test.ts`
- `web-ui/src/components/detail-panels/cline-markdown-content.tsx`
- `web-ui/src/components/cline-add-provider-dialog.tsx` + `.test.tsx`
- `web-ui/src/components/cline-setup-section.tsx`
- `web-ui/src/components/cline-icon.tsx`

### Delete entirely — hooks

- `web-ui/src/hooks/use-cline-chat-panel-controller.ts` + `.test.tsx`
- `web-ui/src/hooks/use-cline-chat-runtime-actions.ts` + `.test.tsx`
- `web-ui/src/hooks/use-cline-chat-session.ts` + `.test.tsx`
- `web-ui/src/hooks/use-runtime-settings-cline-controller.ts` + `.test.tsx`
- `web-ui/src/hooks/use-runtime-settings-cline-mcp-controller.ts` + `.test.tsx`

## Phase 4: Edit shared frontend files

**`web-ui/src/App.tsx`:**
- Remove `clineSessionContextVersion` import/usage
- Remove `clineProviderSettings` from settings config
- Remove any Cline-specific panel routing — all agents use terminal panel

**`web-ui/src/components/card-detail-view.tsx`:**
- Remove native chat panel branch for Cline — always render terminal panel

**`web-ui/src/components/runtime-settings-dialog.tsx`:**
- Remove `ClineSetupSection` component usage
- Remove `isNativeCline` checks
- Remove Cline from `SETTINGS_AGENT_ORDER` special handling (keep it in the normal agent list)

**`web-ui/src/runtime/runtime-config-query.ts`:**
- Delete all ~20 Cline-specific query functions:
  - `saveClineProviderSettings`
  - `addClineProvider`
  - `updateClineProvider`
  - `getClineProviderCatalog`
  - `getClineAccountProfile`
  - `getClineKanbanAccess`
  - `getClineMcpAuthStatuses`
  - `runClineMcpServerOAuth`
  - `getClineMcpSettings`
  - `saveClineMcpSettings`
  - `runClineProviderOAuthLogin`
  - `getClineProviderModels`

**`web-ui/src/runtime/native-agent.ts`:**
- Remove Cline agent detection and setup satisfaction checks (or delete the file entirely if it only serves Cline)

**`web-ui/src/runtime/use-runtime-state-stream.ts`:**
- Remove handling for `cline_session_context_updated` and `mcp_auth_updated` stream events

## Phase 5: Cleanup dependencies and config

**`package.json`:**
- Remove `@clinebot/agents`, `@clinebot/core`, `@clinebot/llms`, `@clinebot/shared`
- Run `npm install` to clean lockfile

**Config files (if referencing cline-sdk paths):**
- `biome.json` — remove any Cline SDK path references in lint config
- `vitest.config.ts` — remove Cline SDK test paths if explicitly configured
- `tsconfig.json` — remove path aliases if any point to cline-sdk

## Phase 6: Update docs and verify

**Edit:**
- `CLAUDE.md` — remove Cline SDK references from architecture description and tribal knowledge
- `AGENTS.md` — remove Cline SDK tribal knowledge entries
- `docs/architecture.md` — update if it references native Cline chat

**Verify:**
```bash
npm run check          # lint + typecheck + tests
npm run build          # production build
npm run web:test       # web UI tests
npm run web:typecheck  # web UI types
```

## Risk areas

1. **`runtime-api.ts` is the biggest edit** — it's the god-file that coordinates everything. The Cline service calls are interleaved with generic session logic. Needs careful surgery.
2. **`app-router.ts` procedure removal** — the tRPC router type is inferred from all procedures. Removing 13 procedures will cascade type changes to the frontend tRPC client.
3. **Stream message types** — the runtime state stream union includes Cline messages. Frontend reducer must stop expecting them.
4. **Default agent change** — switching from `"cline"` to `"claude"` as default means existing user configs with `"cline"` will still work (it's still in the agent catalog), but Cline will show as "not installed" unless the CLI binary is on PATH.

## Notes

- The Cline agent catalog entry in `src/core/agent-catalog.ts` stays. Cline remains a supported agent — it just becomes a normal CLI agent like all the others.
- The `"cline"` value in the `RuntimeAgentId` enum stays for the same reason.
- Existing user configs that have `selectedAgentId: "cline"` will still load, but Cline will require the CLI binary to be installed.
