# Icon System Notes

## Current state (2026-04-07)

Replaced the old robot/bot icon (from upstream kanban project) with a **sailboat** from [Lucide Icons](https://github.com/lucide-icons/lucide) (MIT licensed) to match the Quarterdeck nautical theme.

## What lives where

| File | Purpose | How it's used |
|------|---------|---------------|
| `web-ui/index.html` | **Browser tab favicon** | Inline SVG data URI — white (`#E6EDF3`) strokes with black outline, transparent background |
| `web-ui/public/assets/icon-512.png` | PWA app icon (large) | Referenced in `manifest.json` |
| `web-ui/public/assets/icon-192.png` | PWA app icon (small) | Referenced in `manifest.json` |
| `web-ui/public/assets/icon-notification.png` | Notification badge (64px) | Used for browser notifications |

## Why the favicon is inline SVG

The original project used an inline SVG data URI for the favicon rather than linking to a file. This avoids a network round-trip (icon renders instantly with the HTML), avoids stale browser favicon caching, and works even if static assets haven't loaded yet. We kept this pattern.

## How the PNGs were generated

Source SVG from Lucide, patched and rasterized with `rsvg-convert` (from `librsvg`):

```bash
# 1. Download the lucide sailboat SVG
curl -s -o /tmp/sailboat.svg https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/sailboat.svg

# 2. Create outlined version (black outline behind white strokes, transparent bg)
cat > /tmp/sailboat.svg << 'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <g stroke="black" stroke-width="4">
    <path d="M10 2v15" />
    <path d="M7 22a4 4 0 0 1-4-4 1 1 0 0 1 1-1h16a1 1 0 0 1 1 1 4 4 0 0 1-4 4z" />
    <path d="M9.159 2.46a1 1 0 0 1 1.521-.193l9.977 8.98A1 1 0 0 1 20 13H4a1 1 0 0 1-.824-1.567z" />
  </g>
  <g stroke="white" stroke-width="2">
    <path d="M10 2v15" />
    <path d="M7 22a4 4 0 0 1-4-4 1 1 0 0 1 1-1h16a1 1 0 0 1 1 1 4 4 0 0 1-4 4z" />
    <path d="M9.159 2.46a1 1 0 0 1 1.521-.193l9.977 8.98A1 1 0 0 1 20 13H4a1 1 0 0 1-.824-1.567z" />
  </g>
</svg>
SVG

# 3. Rasterize to PNGs (requires librsvg: brew install librsvg)
rsvg-convert -w 512 -h 512 /tmp/sailboat.svg -o web-ui/public/assets/icon-512.png
rsvg-convert -w 192 -h 192 /tmp/sailboat.svg -o web-ui/public/assets/icon-192.png
rsvg-convert -w 64  -h 64  /tmp/sailboat.svg -o web-ui/public/assets/icon-notification.png
```

## Design decisions

- **Black outline + white fill on transparent** — works on both light and dark browser chrome. Pure white on transparent (like the old robot) disappears on light themes.
- **Lucide icon set** — already used throughout the app for UI icons, so the sailboat is stylistically consistent.
- **Stroke-based, not filled** — matches Lucide's design language (2px strokes, round caps/joins).

## To replace with a custom icon later

1. Update the inline SVG data URI in `web-ui/index.html` (URL-encode the SVG, use `%22` for quotes, `%23` for `#`)
2. Regenerate the three PNGs at 512, 192, and 64px using the script above (or any SVG-to-PNG tool)
3. If switching away from Lucide, update the license attribution if needed
