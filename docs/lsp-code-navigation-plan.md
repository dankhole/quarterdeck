# Code navigation with user-installed language servers

Quarterdeck provides optional definitions, references, and type information in live Files workspaces through user-installed Language Server Protocol (LSP) executables. It does not bundle or install servers. Code navigation is disabled by default and supports stdio transport only.

## Setup and use

1. Install a language server separately and make its executable available to the owning runtime. Desktop users can configure executable folders in [Runtime Environment](./desktop-environment.md).
2. Open **Settings → Code Navigation**, enable code navigation, and edit or add a server. **Check command** verifies executable availability without starting the server. Save the settings to apply changes.
3. Open a complete, editable text file in a live project or task Files workspace. Use the editor context menu's **Go to Definition**, **Find References**, or **Show Type Information** action at the desired position.
4. Select a definition/reference result to open its file and position. Results are grouped by relative path and show line/column locations. Type information appears as text in the results panel.

Opening Settings or an eligible file does not launch a server. The first navigation action starts one on demand and may wait for initialization/indexing. Missing executables, disabled configuration, unsupported actions, and empty results have explicit UI states. Read-only Git revisions and diff views do not support navigation; open the live worktree file instead.

The only shipped template is TypeScript/JavaScript:

| Executable | Arguments | Extensions | Root markers |
| --- | --- | --- | --- |
| `typescript-language-server` | `["--stdio"]` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` | `tsconfig.json`, `jsconfig.json`, `package.json` |

Other languages require a custom server definition. Configuration stores an ID, display label, enabled flag, executable, argument array, extensions, root markers, and optional initialization-options/environment JSON. **Restore default templates** restores the shipped TS/JS definition. Up to 20 server definitions may be saved; the first enabled definition matching the file extension is selected.

Commands and arguments are separate values, never a shell command string. Use an executable on the runtime's `PATH` or an absolute executable path. Windows `.cmd` wrappers cannot be launched directly; configure `node.exe` with the language server's JavaScript entrypoint and arguments instead. Server-specific behavior belongs in configuration rather than the generic manager.

## Document and scope correctness

Each request carries the exact unsaved editor content, its document version, and a zero-based UTF-16 position. The runtime validates the live project/task scope, file access, text content, size, and position before requesting navigation. Language roots are resolved upward from the file to the nearest configured root marker, without escaping the live scope; the scope root is the fallback.

Requests for one server are serialized. Each exchanges `didOpen`, the requested operation, and `didClose`, using a runtime-monotonic document version. Servers must support opening/closing unsaved documents and the requested capability. Continuous `didChange` subscriptions are not implemented.

The browser rejects a pending response after its source document changes or closes, or its scope/configuration changes. Completed definition/reference lists remain available while navigating within their original scope. Server results are accepted only for readable files inside that live scope; non-file URIs, escaped paths, missing files, and duplicate locations are discarded.

The tRPC operations are `project.codeNavigation.status`, `.definition`, `.references`, and `.hover`. Project identity comes from the project-scoped client. Inputs use `path`, optional `taskId`/ref scope fields, and, for navigation, `position`, `documentVersion`, and `content`; references also accept `includeDeclaration`. The API returns typed unavailable/error states or versioned results. The schemas in `src/core/api/code-navigation.ts` own the exact contract.

## Process ownership and limits

`LanguageNavigationManager` owns process reuse and resource policy; `LanguageSession` owns protocol/document correctness through `vscode-languageserver-protocol`. A process is reused for the same project, live scope root, server ID, and resolved language root. Changed configuration stops obsolete sessions. Project removal, relocation, runtime shutdown, and idle reaping retain runtime ownership of cleanup.

| Limit | Current value |
| --- | --- |
| Sessions | 3 per project; 16 per runtime |
| Pending requests per server, including the active request | 8 |
| Initialization and individual request deadlines | 30 seconds each |
| Idle shutdown | After 15 minutes without pending requests, checked at most once per minute |
| Document content | 5 MB editor limit |
| Mapped result candidates | First 500; UI reports truncation |
| Stdout budget | 32 MiB during initialization and between request resets |
| Hover text | 32,768 characters |

POSIX sessions own detached process groups. On Windows, a trusted system PowerShell supervisor joins a kill-on-close Job Object before directly launching the server with inherited protocol pipes. Its sole noninheritable job handle keeps workers owned after the server crashes. Private environment values carry launch data without expanding the supervisor command line and are removed before the server inherits its environment.

Diagnostics retain server ID, operation, result counts, bounded failure category/stage, and exit code/signal without server output or document content. Server diagnostic notifications are discarded; they are not editor diagnostics.

## Validation and deferred scope

Focused synthetic protocol/process and frontend tests cover configuration, root/path admission, unsaved snapshots, request serialization, result mapping, stale-response rejection, process limits, and cleanup. Real third-party server compatibility and native Windows acceptance remain open. Windows tests must establish kernel cleanup and argument/pipe behavior; source inspection on macOS does not satisfy that gate.

Additional built-in templates, continuous document synchronization, keyboard shortcuts/command-palette actions, result snippets, automatic warmup, rename/workspace-symbol operations, diagnostics display, read-only-ref navigation, and TCP/socket transport are deferred design options. Current work belongs in the primary checkout's local Chit backlog, not a second Markdown checklist. The [historical phased plan](./history/lsp-code-navigation-plan.md) preserves the original proposal.
