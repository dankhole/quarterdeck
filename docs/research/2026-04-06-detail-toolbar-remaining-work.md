# Detail Toolbar — Remaining Work

**Date**: 2026-04-06 (split from original file-browser-and-detail-toolbar-improvements.md)
**Planned feature**: `docs/planned-features.md` #4 (Detail toolbar and diff viewer improvements)

The file browser panel and full-screen expansion from the original research doc are complete. These are the remaining open items.

---

## 1. Resize clamp prevents diff viewer from taking full width

The file tree panel clamp is max 0.6 in `use-card-detail-layout.ts`, so the diff viewer floors at 40% width. Increase the max to allow the diff viewer to take most or all of the horizontal space.

**Current values** (`use-card-detail-layout.ts`):

| Preference | Default | Clamp |
|---|---|---|
| Collapsed file tree ratio | 0.3333 | 0.12–0.60 |
| Expanded file tree ratio | 0.16 | 0.12–0.60 |

---

## 2. Git history resize handle is inverted

In `git-commit-diff-panel.tsx`, the resize handler uses `startRatio - deltaRatio` (minus) instead of `startRatio + deltaRatio` (plus), inverting the drag direction.

The main `card-detail-view.tsx` handle uses subtraction too, but that's correct because the file tree is on the LEFT — dragging right should shrink it. The git history panel's handle needs investigation to determine if its layout orientation justifies the same math or if it's genuinely inverted.

**Areas to investigate**:
- The side panel resize handle at line 598–603 (between side panel and main content)
- Whether the container width calculation correctly excludes the toolbar width (line 295: `container.offsetWidth - TOOLBAR_WIDTH`)
- Whether the `containerRef` correctly references the expected DOM element in all expansion states

---

## Reference

Completed work archived at: `docs/archive/2026-04-06-file-browser-and-detail-toolbar-completed.md`
