# Code navigation with user-installed language servers

Quarterdeck provides optional definitions, references, and type information in live Files workspaces and the new/right WORKTREE side of Compare and uncommitted diffs through user-installed Language Server Protocol (LSP) executables. It does not bundle or install servers. Code navigation is disabled by default and supports stdio transport only.

Syntax highlighting and click-to-highlight occurrences are separate from navigation: supported editor languages, including C#, are colored without enabling LSP or installing a server. Clicking an identifier highlights matching whole words in Files and across the visible sides of a diff. These are lexical matches, not semantic references; identical names in unrelated scopes may also highlight. Moving the caret to whitespace clears Files matches; clicking whitespace or pressing Escape clears diff matches. A language server adds semantic operations; it does not supply the editor's syntax grammar.

## Setup and use

1. Install a language server separately and make its executable available to the owning runtime. Desktop users can configure executable folders in [Runtime Environment](./desktop-environment.md).
2. Open **Settings → Code Navigation**, enable code navigation, and edit or add a server. **Check command** verifies executable availability without starting the server. Save the settings to apply changes.
3. Open a complete text file in a live project or task Files workspace, or compare against WORKTREE in Compare/uncommitted changes. Right-click the desired symbol in the editor or the new/right diff text and choose **Go to Definition**, **Find References**, or **Show Type Information**.
4. A single unambiguous definition opens immediately. Multiple definitions and **Find Usages** results open in a floating dialog, grouped by file with counts and a read-only preview of the selected file's current disk contents. The dialog does not expand or reflow the underlying editor or diff. Use ↑/↓ to select, Enter or a result click to open its exact range, and Escape to close. The preview does not replace unsaved editor drafts. Type information appears as text in the same floating dialog.

In Files, or after clicking new/right diff text, use **⌘B** (macOS) / **Ctrl+B** (other platforms) for definitions and **Alt+F7** for references. **⌘-click** / **Ctrl-click** on a symbol also opens its definition. Type information uses **Ctrl+J** on macOS or **Ctrl+Q** elsewhere. Context menus show the shortcuts. In diffs, code clicks select/highlight symbols; use the line gutter to add review comments.

Opening Settings or an eligible file does not launch a server. The first navigation action starts one on demand and may wait for initialization/indexing. Missing executables, disabled configuration, unsupported actions, and empty results have explicit UI states. Unavailable or failed navigation actions also show a toast so errors are not confined to the results panel; the panel retains the details. Old/base diff text and historical Git revisions explicitly report that navigation is unavailable; they never query the live index using historical positions. Eligibility uses explicit content provenance, not the ref label: a branch named `WORKTREE` remains historical when uncommitted work is excluded. New/right WORKTREE diff requests use the complete new-side snapshot and the clicked UTF-16 position, including nested syntax/inline-diff spans. Diff review remains immutable: navigation grants no edit or save capability. Definition/reference results open the live Files workspace at their exact range in the original project/task scope. In a detached review window, results instead open a floating read-only live-file preview without mounting an editable Files workspace or replacing the underlying diff. Closing that preview returns to the review.

The only shipped template is TypeScript/JavaScript:

| Executable | Arguments | Extensions | Root markers |
| --- | --- | --- | --- |
| `typescript-language-server` | `["--stdio"]` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` | `tsconfig.json`, `jsconfig.json`, `package.json` |

The TypeScript template requires both `typescript-language-server` and a compatible TypeScript language service. TypeScript 7 does not include the JavaScript `lib/tsserver.js` used by this wrapper; use a separate compatible TypeScript 6 installation and set `initializationOptions.tsserver.path` to its absolute `lib/tsserver.js` path when necessary. This does not require downgrading the project's compiler dependency. An absolute server command also avoids desktop PATH discovery differences.

Other languages, including Java and C#, require a custom server definition. Java files use the LSP language ID `java`; `.cs` and `.csx` files use `csharp`. An installed IDE does not automatically expose its language services to Quarterdeck. Configuration stores an ID, display label, enabled flag, executable, argument array, extensions, root markers, and optional initialization-options/environment JSON. **Restore default templates** restores the shipped TS/JS definition. Up to 20 server definitions may be saved; the first enabled definition matching the file extension is selected.

Commands and arguments are separate values, never a shell command string. Use an executable on the runtime's `PATH` or an absolute executable path. Windows `.cmd` wrappers cannot be launched directly; configure `node.exe` with the language server's JavaScript entrypoint and arguments instead. Server-specific behavior belongs in configuration rather than the generic manager.

## Ignoring comments in searches

**Search in files** (⌘/Ctrl+Shift+F) and **Find Usages** each offer an **Ignore comments** toggle, off by default. Changing it reruns the current search. Usages rerun the original symbol request, not the selected preview; definitions and type information are unaffected. Project text search does not require a language server.

Filtering uses syntax tokens rather than removing every `//`, `/* … */`, or `#` sequence. Matches in strings remain searchable, and a line containing both matching code and a trailing comment remains a result. Original source text and line numbers are preserved. Text search classifies the selected Git revision when browsing a ref; usages classify the unsaved source snapshot and bounded live snapshots of other returned files.

The classifier covers JS/TS/JSX/TSX, Java, C#/CSX, C/C++, Python, Ruby, Go, Rust, SQL, CSS, HTML/XML, YAML, and JSON/JSONC. It is a syntax highlighter, not a compiler: unsupported extensions, unreadable or unclassifiable sources, and files above 1 MiB retain their matches. Classification also has a 10 MiB aggregate request budget. Shell files, Python f-string files, C# raw-string syntax or a known ambiguous verbatim-string escape, and detected ambiguous JS slash/YAML hash forms conservatively leave the whole file unfiltered. Python triple-quoted strings, including docstrings, remain strings. These fallbacks prefer extra results over silently hiding code. The existing 500-candidate LSP limit still applies, with truncation reported even when filtering removes candidates.

A runtime must acknowledge the filtering option. If an older runtime does not, the UI reports that the runtime must be updated instead of showing unfiltered results as filtered. No persisted settings migration is needed.

## Document and scope correctness

Each request carries the exact unsaved editor content, its document version, and a zero-based UTF-16 position. Diff click targets must be resolved during capture, before occurrence highlighting can replace the clicked syntax spans; resolving them from the later bubbling event can lose the symbol. The runtime validates the live project/task scope, file access, text content, size, and position before requesting navigation. Language roots are resolved upward from the file to the nearest configured root marker, without escaping the live scope; the scope root is the fallback.

Requests for one server are serialized. Each exchanges `didOpen`, the requested operation, and `didClose`, using a runtime-monotonic document version. Servers must support opening/closing unsaved documents and the requested capability. Continuous `didChange` subscriptions are not implemented.

The browser rejects a pending response after its source document changes or closes, or its scope/configuration changes. In Files, completed definition/reference lists remain available while navigating within their original scope. Diff results are cleared when their source snapshot, revision pair, live scope, or navigation configuration changes. Server results are accepted only for readable files inside that live scope; non-file URIs, escaped paths, missing files, and duplicate locations are discarded.

The tRPC operations are `project.codeNavigation.status`, `.definition`, `.references`, and `.hover`. Project identity comes from the project-scoped client. Inputs use `path`, optional `taskId`/ref scope fields, and, for navigation, `position`, `documentVersion`, and `content`; references also accept `includeDeclaration` and `ignoreComments`. The API returns typed unavailable/error states or versioned results. The schemas in `src/core/api/code-navigation.ts` own the exact contract.

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

Additional built-in templates, continuous document synchronization, command-palette actions, inline result snippets, automatic warmup, rename/workspace-symbol operations, diagnostics display, read-only-ref navigation, and TCP/socket transport are deferred design options. Current work belongs in the primary checkout's local Chit backlog, not a second Markdown checklist. The [historical phased plan](./history/lsp-code-navigation-plan.md) preserves the original proposal.
