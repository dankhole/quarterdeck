# Quarterdeck Renderer

This package contains the React UI embedded in Quarterdeck's macOS and Windows Electron apps. It is not a standalone browser product. The production renderer requires the validated desktop preload bridge and authenticated local runtime transport.

## Stack

React, TypeScript, Vite, Tailwind CSS, Radix UI, drag-and-drop, CodeMirror, xterm and Vitest. Packaged end-to-end tests use the root Playwright Electron driver, not a web-package browser test suite.

## Scripts

Run these from `web-ui/`; root equivalents use `web:` prefixes:

- `npm run build`: typecheck and create the production renderer bundle.
- `npm run typecheck`: typecheck without bundling.
- `npm run test -- <paths...>`: all or focused colocated Vitest tests.

See [development](../DEVELOPMENT.md#development-and-internal-runtimes) and [test selection](../docs/testing.md). UI tests remain colocated under `src`. Functional tests use a fresh local candidate in the isolated [packaged Agent Lab](../docs/agent-functional-testing.md); hidden Electron runs and internal headless runtime fixtures remain supported.
