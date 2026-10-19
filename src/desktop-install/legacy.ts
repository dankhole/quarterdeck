import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";

import { isNodeError } from "../fs/node-error.js";
import {
	desktopVersionSchema,
	legacyManagedDesktopInstallationReceiptSchema,
	managedDesktopInstallationReceiptFilename,
	managedDesktopSelectionSchema,
} from "./receipt.js";

const MAXIMUM_ENTRIES = 100;
const MAXIMUM_RECEIPT_BYTES = 16 * 1024;
const INSTALL_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export interface LegacyDesktopEvidence {
	path: string;
	kind: "installation" | "selection" | "uncertain";
	message: string;
	appPath?: string;
}

export interface LegacyDesktopInventory {
	root: string;
	pending: boolean;
	truncated: boolean;
	retained: LegacyDesktopEvidence[];
}

async function readLegacyJson(path: string): Promise<unknown> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > MAXIMUM_RECEIPT_BYTES)
			throw new Error("Invalid legacy metadata");
		const bytes = Buffer.alloc(MAXIMUM_RECEIPT_BYTES + 1);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		const after = await file.stat();
		if (bytesRead > MAXIMUM_RECEIPT_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
			throw new Error("Changed legacy metadata");
		return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
	} finally {
		await file.close();
	}
}

/** Read only the old managed locations. Tests inject a private home; production uses the OS account, never HOME. */
export async function inventoryLegacyDesktopInstallations(home = userInfo().homedir): Promise<LegacyDesktopInventory> {
	const root = join(resolve(home), "Library/Application Support/Quarterdeck/managed-apps");
	const result: LegacyDesktopInventory = { root, pending: false, truncated: false, retained: [] };
	const uncertain = (path: string, message: string) => {
		result.retained.push({ path, kind: "uncertain", message });
	};
	async function directory(path: string): Promise<boolean> {
		try {
			const info = await lstat(path);
			if (info.isDirectory() && !info.isSymbolicLink()) return true;
			uncertain(path, "Not a real legacy directory; retained without following it.");
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) uncertain(path, "Legacy directory could not be inspected; retained.");
		}
		return false;
	}

	for (const path of [
		resolve(home),
		join(resolve(home), "Library"),
		join(resolve(home), "Library/Application Support"),
		join(resolve(home), "Library/Application Support/Quarterdeck"),
		root,
	]) {
		if (!(await directory(path))) {
			result.pending = result.retained.length > 0;
			return result;
		}
	}

	let entries = 0;
	for (const category of ["installations", "selections"] as const) {
		const container = join(root, category);
		if (!(await directory(container))) continue;
		try {
			const children = await opendir(container);
			for await (const child of children) {
				if (++entries > MAXIMUM_ENTRIES) {
					result.truncated = true;
					uncertain(
						container,
						"Legacy inventory limit reached; additional entries were retained and not inspected.",
					);
					break;
				}
				const path = join(container, child.name);
				try {
					const info = await lstat(path);
					if (info.isSymbolicLink()) {
						uncertain(path, "Legacy symbolic link retained without following its target.");
						continue;
					}
					if (category === "selections") {
						const name = /^(.*)-darwin-(arm64|x64)\.json$/u.exec(child.name);
						if (!info.isFile() || !name || !desktopVersionSchema.safeParse(name[1]).success)
							throw new Error("Unknown selection");
						const selection = managedDesktopSelectionSchema.parse(await readLegacyJson(path));
						result.retained.push({
							path,
							kind: "selection",
							message: `Legacy selection for ${selection.installId}; retained, target not followed.`,
						});
						continue;
					}
					if (!info.isDirectory() || !INSTALL_ID.test(child.name)) throw new Error("Unknown legacy slot");
					const receipt = legacyManagedDesktopInstallationReceiptSchema.parse(
						await readLegacyJson(join(path, managedDesktopInstallationReceiptFilename)),
					);
					if (receipt.installId !== child.name) throw new Error("Mismatched legacy receipt");
					const appPath = join(path, receipt.appPath);
					const appInfo = await lstat(appPath);
					if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw new Error("Changed legacy app");
					result.retained.push({
						path,
						appPath,
						kind: "installation",
						message: `Recorded legacy ${receipt.version} ${receipt.arch} app; content identity and lack of use remain unverified.`,
					});
				} catch {
					uncertain(
						path,
						"Unknown, malformed, changed, or unreadable legacy evidence; retained without further traversal.",
					);
				}
			}
		} catch {
			uncertain(container, "Legacy directory could not be enumerated; retained.");
		}
		if (result.truncated) break;
	}
	result.retained.sort((left, right) => left.path.localeCompare(right.path));
	result.pending = result.retained.length > 0;
	return result;
}

export function formatLegacyDesktopMigrationGuidance(inventory: LegacyDesktopInventory): string[] {
	if (!inventory.pending) return [];
	return [
		"Legacy desktop migration pending. No legacy files were removed; the new app's readiness does not complete migration.",
		...inventory.retained.map(
			(entry) =>
				`Retained ${JSON.stringify(entry.path)}${entry.appPath ? `; app ${JSON.stringify(entry.appPath)}` : ""}: ${entry.message}`,
		),
		"Quit old Quarterdeck apps. Remove the old Quarterdeck Dock shortcut; after installing the new app, add ~/Applications/Quarterdeck.app to the Dock once.",
		"Manually remove only exact obsolete app copies after verifying their identity and that they are unused. Leave unknown, modified, or running copies in place; automatic pruning is disabled.",
	];
}
