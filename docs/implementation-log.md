# Implementation Log

> Prior entries in `docs/history/`: `implementation-log-through-0.12.0.md`, `implementation-log-through-0.11.0.md`, `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## 2026-04-29 — Codex prompt option separator

Codex rejects prompt positionals that start with `-` unless they are preceded by `--`. The failure can surface through resume even though browser restart/restore sends an empty prompt, because terminal auto-restart clones the original task start request and then flips it to `resumeConversation=true` while preserving the original prompt. A task whose prompt starts with a bullet can therefore become `codex resume ... "- ..."` and fail in clap before the TUI opens.

The Codex adapter now appends `--` before prompt positionals after all `resume`, hook, feature, and developer-instruction arguments have been assembled. This uses Codex's standard CLI argument boundary for every prompt, protecting fresh starts and resume starts without changing no-prompt resume behavior. Notable files: `src/terminal/agent-session-adapters.ts` and `test/runtime/terminal/agent-session-adapters.test.ts`. Validation: targeted adapter tests, agent-instruction bridge check, and typecheck.

## 2026-04-29 — Live terminal write batching

Task terminal live IO now enters xterm through an explicit `TerminalWriteOptions.batch` path. `SlotSocketManager` marks only websocket IO chunks as batchable; restore snapshots, reset/clear actions, and local status text leave batching off. `SlotWriteQueue` coalesces same-kind string or byte chunks until the next animation frame, a 16 ms fallback timer, or size/count caps, then sends one aggregate `terminal.write` while preserving output-ack byte totals and output-text notifications.

The key invariant is ordering: `drain()`, `chainAction()`, and immediate writes all flush any pending live batch before restore/reset/status operations proceed. This keeps the untrash/reconnect restore guards intact while reducing browser main-thread churn from high-volume agent output. Notable files: `web-ui/src/terminal/slot-write-queue.ts`, `slot-socket-manager.ts`, `terminal-write-options.ts`, and focused queue/socket tests. Validation: `npm run typecheck`, `npm run test:fast`, and `npm run web:test -- src/terminal/slot-write-queue.test.ts src/terminal/slot-socket-manager.test.ts`.
