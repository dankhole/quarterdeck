# Test Layout

Use [`docs/testing.md`](../docs/testing.md) to choose the smallest validation set that proves a change. This file owns placement and naming for the root Vitest tree.

- `test/runtime`: unit and focused integration tests grouped by runtime subsystem, including config, diagnostics, Git/worktrees, server, state, terminal, and tRPC
- `test/integration`: cross-subsystem tests that exercise filesystem, process, WebSocket, or CLI boundaries
- `test/utilities`: shared test helpers and fixtures used by both suites

Use `*.test.ts` for deterministic focused tests and `*.integration.test.ts` for cross-boundary behavior. Keep test-only support code in `test/utilities` instead of inventing parallel fixture directories.

Prefer colocating a new test with the nearest existing subsystem group. A test belongs in `test/integration` only when crossing the real boundary is part of the invariant; using several modules does not by itself make a test an integration test.

Use `npm run test -- <test-path...>` for a focused root run. `npm run test:fast` covers `test/runtime` and `test/utilities`, `npm run test:integration` covers the complete integration directory, and the unfiltered `npm run test` discovers both.

Tests that touch state, repositories, processes, or HOME-like configuration must use disposable roots and shared helpers. Never point a test at the developer's normal Quarterdeck state, provider profile, or active runtime.
