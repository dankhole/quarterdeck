# Test Layout

- `test/runtime`: unit and focused integration tests grouped by runtime subsystem, including config, diagnostics, Git/worktrees, server, state, terminal, and tRPC
- `test/integration`: cross-subsystem tests that exercise filesystem, process, WebSocket, or CLI boundaries
- `test/utilities`: shared test helpers and fixtures used by both suites

Use `*.test.ts` for deterministic focused tests and `*.integration.test.ts` for cross-boundary behavior. Keep test-only support code in `test/utilities` instead of inventing parallel fixture directories.
