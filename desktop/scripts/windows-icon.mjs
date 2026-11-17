import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { desktopRoot, repoRoot } from "./paths.mjs";

/** ICO supports PNG payloads. Preserve the existing PWA artwork byte for byte. */
export async function windowsDesktopIcon(path = join(desktopRoot, ".cache/quarterdeck.ico")) {
	const png = await readFile(join(repoRoot, "web-ui/public/assets/icon-192.png"));
	const size = png.readUInt32BE(16);
	if (size !== 192 || png.readUInt32BE(20) !== 192) throw new Error("Unexpected Quarterdeck icon dimensions.");
	const header = Buffer.alloc(22);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(1, 4);
	header[6] = size;
	header[7] = size;
	header.writeUInt16LE(1, 10);
	header.writeUInt16LE(32, 12);
	header.writeUInt32LE(png.length, 14);
	header.writeUInt32LE(header.length, 18);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, Buffer.concat([header, png]));
	return path;
}
