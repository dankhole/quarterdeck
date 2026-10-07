import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { DesktopInstallationError } from "./errors.js";

export async function desktopFileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export async function readDesktopJson(path: string, maximumBytes = 128 * 1024): Promise<unknown> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.size > maximumBytes) {
		throw new DesktopInstallationError("invalid_artifact", "Desktop metadata must be a bounded regular file.");
	}
	try {
		const bytes = await readFile(path);
		if (bytes.length > maximumBytes) throw new Error("Metadata grew while reading.");
		return JSON.parse(bytes.toString("utf8")) as unknown;
	} catch {
		throw new DesktopInstallationError("invalid_artifact", "Desktop metadata could not be read safely.");
	}
}

function contained(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Hash file content, link text and executable bits; never traverse framework aliases. */
export async function desktopAppTreeSha256(appPath: string): Promise<string> {
	const root = await realpath(appPath);
	if (!(await lstat(root)).isDirectory())
		throw new DesktopInstallationError("invalid_artifact", "The app must be a directory.");
	const hash = createHash("sha256");
	let entries = 0;
	let bytes = 0;
	async function visit(directory: string): Promise<void> {
		const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);
		for (const child of children) {
			if (++entries > 60_000)
				throw new DesktopInstallationError("invalid_artifact", "The app contains too many files.");
			const path = join(directory, child.name);
			const name = relative(root, path);
			const metadata = await lstat(path);
			if (metadata.isSymbolicLink()) {
				if (!contained(root, await realpath(path))) {
					throw new DesktopInstallationError(
						"invalid_artifact",
						"The app contains an external or invalid symbolic link.",
					);
				}
				hash.update(JSON.stringify(["link", name, await readlink(path)]));
			} else if (metadata.isDirectory()) {
				hash.update(JSON.stringify(["directory", name]));
				await visit(path);
			} else if (metadata.isFile()) {
				bytes += metadata.size;
				if (bytes > 3 * 1024 * 1024 * 1024)
					throw new DesktopInstallationError("invalid_artifact", "The expanded app is too large.");
				hash.update(
					JSON.stringify([
						"file",
						name,
						(metadata.mode & 0o111) !== 0,
						metadata.size,
						await desktopFileSha256(path),
					]),
				);
				const after = await lstat(path);
				if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ino !== metadata.ino) {
					throw new DesktopInstallationError("invalid_artifact", "The app changed while it was being verified.");
				}
			} else {
				throw new DesktopInstallationError("invalid_artifact", "The app contains a special filesystem entry.");
			}
		}
	}
	await visit(root);
	return hash.digest("hex");
}

/** Only call for our copied app/stage, never for the caller's source app. */
export async function setDesktopTreeWritable(path: string, writable: boolean): Promise<void> {
	const metadata = await lstat(path);
	if (metadata.isSymbolicLink()) return;
	if (writable) await chmod(path, metadata.mode | 0o200);
	if (metadata.isDirectory()) {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			if (!entry.isSymbolicLink()) await setDesktopTreeWritable(join(path, entry.name), writable);
		}
	}
	if (!writable) await chmod(path, metadata.mode & ~0o222);
}
