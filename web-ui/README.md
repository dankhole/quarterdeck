# Quarterdeck Web UI

This package contains the Quarterdeck frontend served by the runtime.

## Stack

- React + TypeScript + Vite
- Tailwind CSS v4
- Radix UI
- Hello Pangea drag-and-drop
- Vitest
- Playwright

## Scripts

- `npm run dev`: start the Vite development server
- `npm run build`: typecheck and create the production bundle
- `npm run typecheck`: typecheck without bundling
- `npm run test -- <paths...>`: run all or focused colocated Vitest tests
- `npm run e2e`: run the Playwright smoke suite

`npm run e2e` starts a disposable Quarterdeck runtime and git fixture for the
Playwright run. It does not use or mutate the developer's normal
`~/.quarterdeck` state.

Use [`../docs/testing.md`](../docs/testing.md) to decide between focused web tests, the complete web suite, Playwright, and Agent Lab. UI tests are colocated with their source under `src`; `tests/` is reserved for Playwright smoke coverage.
