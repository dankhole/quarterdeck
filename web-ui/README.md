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

- `npm run dev`
- `npm run build`
- `npm run typecheck`
- `npm run test`
- `npm run e2e`

`npm run e2e` starts a disposable Quarterdeck runtime and git fixture for the
Playwright run. It does not use or mutate the developer's normal
`~/.quarterdeck` state.
