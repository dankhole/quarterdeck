import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import { desktopPhysicalFileSystem } from "./files.js";

function identity(info: BigIntStats, checkTimestamps: boolean): string {
	const fields = [info.dev, info.ino, info.mode, info.nlink, info.size];
	if (checkTimestamps) fields.push(info.birthtimeNs, info.ctimeNs, info.mtimeNs);
	return fields.join(":");
}

/** Invalidate the launch cache when a previously content-verified Windows tree changes. */
export async function windowsDesktopTreeFingerprint(root: string): Promise<string | null> {
	const hash = createHash("sha256");
	let entries = 0;
	const batchSize = 32;
	const { lstat, readdir } = desktopPhysicalFileSystem;

	async function visit(directory: string, device: bigint): Promise<boolean> {
		const names = (await readdir(directory)).sort();
		entries += names.length;
		if (entries > 60_000) return false;
		for (let offset = 0; offset < names.length; offset += batchSize) {
			const batch = names.slice(offset, offset + batchSize);
			const results = await Promise.allSettled(batch.map((name) => lstat(join(directory, name), { bigint: true })));
			for (const [index, result] of results.entries()) {
				if (result.status === "rejected") return false;
				const info = result.value;
				const name = batch[index];
				const isDirectory = info.isDirectory();
				if (
					info.ino === 0n ||
					info.dev !== device ||
					info.ctimeNs <= 0n ||
					(!isDirectory && (!info.isFile() || info.nlink !== 1n))
				)
					return false;
				// Publishing the Start menu shortcut can change the launcher's metadata.
				// Launch always hashes this executable's bytes separately.
				const isLauncher = directory === root && name === "Quarterdeck.exe";
				hash.update(JSON.stringify([isDirectory ? "directory" : "file", name, identity(info, !isLauncher)]));
				if (isDirectory && !(await visit(join(directory, name), device))) return false;
			}
		}
		hash.update("]");
		return true;
	}

	try {
		const info = await lstat(root, { bigint: true });
		if (!info.isDirectory() || info.ino === 0n || info.dev === 0n) return null;
		// Promotion renames the root on the same volume. Its identity survives but its timestamps can change.
		hash.update(JSON.stringify(["windows-tree-v2", String(info.dev), String(info.ino)]));
		return (await visit(root, info.dev)) ? hash.digest("hex") : null;
	} catch {
		return null;
	}
}
