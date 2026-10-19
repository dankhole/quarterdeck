import { randomUUID } from "node:crypto";
import { copyFile, lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNodeError } from "../fs/node-error.js";

export async function desktopPathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return false;
		throw error;
	}
}

export async function syncDesktopDirectory(path: string): Promise<void> {
	const file = await open(path, "r");
	try {
		await file.sync();
	} finally {
		await file.close();
	}
}

export async function writeDesktopJson(path: string, value: unknown): Promise<void> {
	const temporary = join(dirname(path), `.json-${randomUUID()}`);
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value, null, "\t")}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
		await syncDesktopDirectory(dirname(path));
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function copyDesktopFileAtomic(source: string, destination: string): Promise<void> {
	const temporary = join(dirname(destination), `.copy-${randomUUID()}`);
	try {
		await copyFile(source, temporary);
		const file = await open(temporary, "r+");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, destination);
		await syncDesktopDirectory(dirname(destination));
	} finally {
		await rm(temporary, { force: true });
	}
}
