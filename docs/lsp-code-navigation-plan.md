# Bring-Your-Own LSP Code Navigation Plan

## Goal

Add source-level navigation to Quarterdeck's Files view without bundling language servers or turning Quarterdeck into a package manager. Users bring their own Language Server Protocol (LSP) executables, and Quarterdeck provides the generic client, lifecycle management, editor integration, and results UI.

Primary user workflows:

- Right-click or command-palette action on a symbol and find references.
- Go to definition from the current cursor position.
- Show hover/type information when the configured language server supports it.
- Open navigation results in the existing Files view/editor surface.

Non-goals for the first milestone:

- Installing language servers.
- Full IDE parity.
- Debugging, test discovery, semantic refactors, or project-wide indexing UI.
- TCP/socket LSP transports. Start with stdio only.

## Product Shape

Quarterdeck ships a generic LSP manager plus editable default templates for common servers. A template is active only when the corresponding command can be found on `PATH` or the user supplies an explicit executable path.

Suggested built-in templates:

| Language | Command | Args | Extensions | Root markers |
| --- | --- | --- | --- | --- |
| TypeScript/JavaScript | `typescript-language-server` | `["--stdio"]` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| Python | `pyright-langserver` | `["--stdio"]` | `.py`, `.pyi` | `pyproject.toml`, `setup.py`, `requirements.txt` |
| Rust | `rust-analyzer` | `[]` | `.rs` | `Cargo.toml` |
| Go | `gopls` | `[]` | `.go` | `go.mod` |
| C/C++ | `clangd` | `[]` | `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hpp`, `.hh`, `.hxx` | `compile_commands.json`, `compile_flags.txt`, `.clangd` |

Configuration should store command and args separately, never as a shell string:

```ts
type LspServerConfig = {
	id: string;
	label: string;
	enabled: boolean;
	command: string;
	args: string[];
	extensions: string[];
	rootMarkers: string[];
	initializationOptions?: unknown;
	env?: Record<string, string>;
};
```

This keeps launch behavior predictable, avoids shell quoting issues, and matches Quarterdeck's existing preference for direct process launches on hot paths.

## Architecture

### Runtime LSP Manager

Add a runtime-side manager responsible for LSP process ownership and protocol routing:

- Resolve a server config by file extension.
- Resolve the workspace root by walking upward from the file path until a configured root marker is found, falling back to the project/worktree root.
- Lazily start one server instance per `(project/worktree root, server id, resolved language root)`.
- Launch via direct child process stdio.
- Send `initialize` / `initialized`.
- Track open documents and editor revisions.
- Send `textDocument/didOpen`, `didChange`, and `didClose`.
- Expose generic navigation operations:
  - `textDocument/definition`
  - `textDocument/references`
  - `textDocument/hover`
- Apply idle shutdown after a configurable timeout.
- Surface structured status/errors to the UI.

Use a small protocol library if it materially reduces risk, preferably SDK-provided LSP protocol/jsonrpc types rather than local redefinitions. If the dependency is not worth it, keep the local protocol layer narrow and typed around only the messages used in the first milestone.

### Public API

Expose language-agnostic tRPC procedures, for example:

```ts
project.codeNavigation.definition({
	projectPath,
	scope,
	filePath,
	position: { line, character },
	documentVersion,
	content,
});

project.codeNavigation.references({
	projectPath,
	scope,
	filePath,
	position: { line, character },
	includeDeclaration: true,
	documentVersion,
	content,
});

project.codeNavigation.hover({
	projectPath,
	scope,
	filePath,
	position: { line, character },
	documentVersion,
	content,
});
```

The API should accept the active editor content so language servers see unsaved edits. The runtime should validate paths through the same file-scope rules used by the Files view before opening or syncing any document.

### Frontend Integration

Keep the current CodeMirror editor. Monaco is not required for the first milestone.

Add CodeMirror integration that can:

- Convert cursor/selection offsets to LSP zero-based `{ line, character }` positions.
- Open a context menu or editor action menu with code-navigation commands when a file has a matching enabled LSP config.
- Send the active document content and revision with each navigation request.
- Render references/definitions in a side panel or modal grouped by file.
- Open a result by selecting the target file in the Files view and moving the editor cursor to the result range.
- Show unavailable states clearly when no server is configured, the command is missing, or the server returns no result.

Initial UI can be intentionally small:

- Context menu actions: `Go to Definition`, `Find References`.
- Optional hover action via keyboard/mouse later, because hover can become noisy and needs careful latency handling.
- A results list grouped by relative path with line previews.

## Lifecycle and Performance Guardrails

Language servers are the heavy part. Guardrails should be part of the MVP, not follow-up polish:

- Lazy start only when a user opens an eligible file or invokes a navigation action.
- Do not start every configured server at app startup.
- Cap concurrent LSP processes per project.
- Idle shutdown after 10-30 minutes with no open documents or requests.
- Kill all project-owned LSP processes on project removal/runtime shutdown.
- Debounce `didChange` for large edits.
- Do not sync files above the existing editor safety limits.
- Keep diagnostics disabled or ignored in the first milestone unless explicitly needed.
- Make status observable in debug logs and, later, a small settings/status surface.

Expected cost:

- Quarterdeck bundle impact should stay small if the frontend only adds editor actions and result panels.
- Runtime memory cost depends on user-provided servers. TS/JS commonly starts `typescript-language-server` plus `tsserver` and can use hundreds of MB on real projects.
- First request may be slow while a server initializes and indexes. The UI should show that as normal startup work, not as a hung action.

## Settings UX

Add a Code Navigation settings section:

- Enable/disable code navigation globally.
- List configured language servers.
- Show command availability status.
- Edit command, args, extensions, root markers, and initialization options.
- Add/remove custom servers.
- Restore default templates.

Do not hide missing commands. A disabled or missing server should explain what executable Quarterdeck tried to launch and how to configure it.

## Phased Rollout

### Phase 1: Generic Transport and TS/JS Template

- Add config schema and settings form for LSP server definitions.
- Implement stdio JSON-RPC client.
- Implement manager lifecycle for start, initialize, request, idle shutdown, and process cleanup.
- Implement path/root resolution.
- Add TS/JS default template.
- Add `definition` and `references` procedures.
- Add CodeMirror context-menu actions and results UI.
- Add focused tests for config parsing, root resolution, process lifecycle, request routing, and result mapping.

### Phase 2: Unsaved Buffer Sync and Multi-Server Support

- Track editor document versions and sync active content reliably.
- Support multiple configured servers across different extensions.
- Add Python, Rust, Go, and C/C++ default templates.
- Add clear unavailable/error states in the UI.
- Add status/debug visibility for active servers.

### Phase 3: Hover and Polish

- Add `hover` request support.
- Add keyboard shortcuts or command-palette actions.
- Add result previews with line snippets.
- Add optional server warmup when opening eligible files if dogfood shows first-action latency is too high.

### Phase 4: Advanced Features

- Rename symbol.
- Workspace symbols.
- Diagnostics display.
- References from read-only refs or diff contexts where path/root semantics are clear.
- Optional TCP/socket transport if a real use case appears.

## Risks and Open Questions

- **Server discovery**: Commands may be installed through user shell managers such as `nvm`, `asdf`, `pyenv`, or `rustup`. Quarterdeck should prefer direct PATH checks inherited from the launched runtime and avoid interactive shell discovery on hot paths.
- **Root detection**: Repositories can contain nested packages. Root marker resolution must be predictable and visible enough to debug.
- **Unsaved content**: Navigation over stale disk content will feel broken. Active editor content must be synced before navigation requests.
- **Read-only scopes**: LSP servers generally expect real workspace files. Definition/references should start with live worktree scopes; read-only git refs can come later.
- **Server quirks**: LSP is standardized, but initialization options and behavior vary. Keep server-specific assumptions in config/templates, not in the generic manager.
- **Resource leaks**: LSP child processes must be tied to project/runtime lifecycle and cleaned up like terminals and other runtime-owned processes.
- **Security**: This feature intentionally launches user-configured commands. It should be opt-in, stored as structured command/args, and never run through a shell string.

## Success Criteria

- A user with `typescript-language-server` already installed can open a TypeScript file, find references, and jump to a result without installing anything through Quarterdeck.
- Missing or disabled language servers produce actionable UI instead of silent failure.
- Multiple languages can be configured without new frontend/editor architecture.
- Quarterdeck starts no LSP processes until code navigation is used.
- Idle language servers shut down without leaving child processes behind.
