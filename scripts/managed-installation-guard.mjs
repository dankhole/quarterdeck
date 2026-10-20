import { lstat, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const maximumReceiptBytes = 128 * 1024;

function validPath(value) {
	return typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value);
}

function receiptOwnership(receipt) {
	// This dependency-free preflight reads ownership, not artifact integrity. The
	// shared installer and launch admission still validate the complete receipt.
	if (
		!receipt || receipt.schemaVersion !== 2 || receipt.managedBy !== "quarterdeck-npm" ||
		!["local", "release"].includes(receipt.source) || !receipt.owner ||
		!["link", "npm"].includes(receipt.owner.kind) ||
		![receipt.owner.packageRoot, receipt.owner.packageSlot, receipt.owner.prefix].every(validPath)
	) throw new Error("The managed desktop installation receipt has invalid ownership metadata.");
	return receipt.owner;
}

async function canonicalPath(path) {
	try {
		return await realpath(path);
	} catch (error) {
		// Resolve surviving ancestors even when a recorded owner or slot vanished.
		if (error.code === "ENOENT") {
			const absolute = resolve(path);
			const parent = dirname(absolute);
			return parent === absolute ? absolute : join(await canonicalPath(parent), basename(absolute));
		}
		throw error;
	}
}

async function canonicalPackageSlot(path) {
	// Resolve the directory, not the final symlink: relinking replaces this slot.
	return join(await canonicalPath(dirname(path)), basename(path));
}

/** Refuse standalone mutations that would invalidate the per-user installed pair. */
export async function assertStandaloneBuildIsSafe(checkoutRoot, options = {}) {
	if ((options.platform ?? process.platform) !== "darwin") return;
	const receiptPath = options.receiptPath ?? join(
		options.userHome ?? userInfo().homedir,
		"Library", "Application Support", "Quarterdeck", "installation", "managed-installation.json",
	);
	let info;
	try {
		info = await lstat(receiptPath);
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw new Error(`Cannot read the managed desktop installation receipt at ${receiptPath}. Resolve its permissions before rebuilding.`, { cause: error });
	}
	let owner;
	try {
		if (!info.isFile() || info.isSymbolicLink() || info.size > maximumReceiptBytes) {
			throw new Error("The receipt must be a bounded real file.");
		}
		owner = receiptOwnership(JSON.parse(await readFile(receiptPath, "utf8")));
	} catch (error) {
		throw new Error(`Cannot verify the managed desktop installation receipt at ${receiptPath}. Resolve the invalid or unreadable receipt before rebuilding or relinking.`, { cause: error });
	}
	if (options.pairedDesktopInstall) return;
	let affectsOwner;
	try {
		const canonicalCheckout = await realpath(checkoutRoot);
		affectsOwner = await canonicalPath(owner.packageRoot) === canonicalCheckout ||
			await canonicalPath(owner.packageSlot) === canonicalCheckout;
		if (!affectsOwner && options.packageSlot) {
			affectsOwner = await canonicalPackageSlot(options.packageSlot) === await canonicalPackageSlot(owner.packageSlot);
		}
	} catch (error) {
		throw new Error(`Cannot resolve managed desktop installation ownership from ${receiptPath}. Resolve its filesystem access before rebuilding.`, { cause: error });
	}
	if (!affectsOwner) return;
	throw new Error(
		`This checkout or npm package slot owns the installed Quarterdeck desktop app. A standalone build, clean, or browser-only link would invalidate its CLI/app pair. Quit Quarterdeck and run npm run link -- --desktop in the intended checkout to rebuild and reinstall both parts, or build in an unrelated worktree. Installed owner: ${owner.packageRoot}.`,
	);
}
