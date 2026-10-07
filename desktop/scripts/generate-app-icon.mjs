import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopRoot, repoRoot } from "./paths.mjs";
import { run } from "./process.mjs";

if (process.platform !== "darwin") throw new Error("Native app icon generation requires macOS sips and iconutil.");
// Preserve the existing Quarterdeck PWA artwork. There is no separate vector
// brand source in the repository; this conversion does not redraw the mark.
const source = join(repoRoot, "web-ui", "public", "assets", "icon-512.png");
const iconset = join(desktopRoot, ".cache", "Quarterdeck.iconset");
await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
	for (const scale of [1, 2]) {
		const pixels = size * scale;
		const file = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
		run("/usr/bin/sips", ["--resampleHeightWidth", String(pixels), String(pixels), source, "--out", file], {
			stdio: "ignore",
		});
	}
}
await mkdir(join(desktopRoot, "assets"), { recursive: true });
run("/usr/bin/iconutil", ["--convert", "icns", "--output", join(desktopRoot, "assets", "quarterdeck.icns"), iconset]);
await rm(iconset, { recursive: true, force: true });
console.log("Converted the existing Quarterdeck app artwork to a native macOS icon.");
