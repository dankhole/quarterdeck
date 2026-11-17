import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { openPromise } from "yauzl";
import { ensurePrivateDirectory } from "../core/private-directory.js";
import { DesktopInstallationError } from "./errors.js";

const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/** Decode only regular files into inherited private ACLs. No shell/extractor or
 * archive-controlled links, device names, alternate streams, or path aliases. */
export async function extractWindowsDesktopArchive(archive: string, destination: string): Promise<void> {
	await ensurePrivateDirectory(destination);
	const zip = await openPromise(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
	const seen = new Set<string>();
	let count = 0,
		bytes = 0;
	try {
		for await (const entry of zip.eachEntry()) {
			const directory = entry.fileName.endsWith("/");
			const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
			const parts = name.split("/");
			const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
			if (
				++count > 60000 ||
				name.length > 4096 ||
				parts.some(
					(part) =>
						!part ||
						part === "." ||
						part === ".." ||
						/[<>:"\\|?*\p{Cc}]|[ .]$/u.test(part) ||
						reserved.test(part),
				) ||
				entry.isEncrypted() ||
				(entry.externalFileAttributes & 0x400) !== 0 ||
				(mode !== 0 && mode !== (directory ? 0o040000 : 0o100000)) ||
				seen.has(name.toLowerCase())
			)
				throw new DesktopInstallationError(
					"invalid_artifact",
					"The Windows archive contains an unsafe, duplicate, or unsupported entry.",
				);
			seen.add(name.toLowerCase());
			bytes += entry.uncompressedSize;
			if (!Number.isSafeInteger(bytes) || bytes > 3 * 1024 * 1024 * 1024)
				throw new DesktopInstallationError(
					"invalid_artifact",
					"The expanded Windows archive exceeds its size limit.",
				);
			const output = join(destination, ...parts);
			if (directory) {
				if (entry.uncompressedSize !== 0) throw new Error("Invalid archive directory.");
				await mkdir(output, { recursive: true, mode: 0o700 });
			} else {
				await mkdir(dirname(output), { recursive: true, mode: 0o700 });
				await pipeline(
					await zip.openReadStreamPromise(entry),
					createWriteStream(output, { flags: "wx", mode: 0o600 }),
				);
			}
		}
	} finally {
		zip.close();
	}
}
