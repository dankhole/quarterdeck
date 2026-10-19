import { spawn } from "node:child_process";
import { constants, fstatSync, lstatSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isNodeError } from "../fs/node-error.js";
import { DesktopInstallationError } from "./errors.js";

export interface DesktopAdmissionDescriptor {
	fd: number;
	path: string;
}

export function desktopInstallationRoot(): string {
	return join(userInfo().homedir, "Library/Application Support/Quarterdeck/installation");
}

export function desktopStableAppPath(): string {
	return join(userInfo().homedir, "Applications/Quarterdeck.app");
}

function privateInfo(info: { uid: number; mode: number }): boolean {
	return info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

export async function ensureDesktopPrivateDirectory(path: string): Promise<void> {
	await validateDesktopDirectoryAncestors(path);
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || !privateInfo(info))
		throw new DesktopInstallationError(
			"installation_changed",
			"The installation metadata directory must be private, user-owned, and not a symbolic link.",
		);
}

/** User-owned directory aliases must not redirect the fixed install tree; OS aliases such as /var are trusted. */
export async function validateDesktopDirectoryAncestors(path: string): Promise<void> {
	let candidate = resolve(path);
	for (;;) {
		try {
			const info = await lstat(candidate);
			if ((info.isSymbolicLink() && info.uid !== 0) || (!info.isDirectory() && !info.isSymbolicLink()))
				throw new DesktopInstallationError(
					"installation_changed",
					"An installation path ancestor is a user-controlled symbolic link or non-directory. No installation files were changed.",
				);
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) throw error;
		}
		if (dirname(candidate) === candidate) break;
		candidate = dirname(candidate);
	}
}

export function getDesktopAdmissionDescriptor(): DesktopAdmissionDescriptor | null {
	const value = process.env.QUARTERDECK_INSTALLATION_LOCK_FD;
	const path = process.env.QUARTERDECK_INSTALLATION_LOCK_PATH;
	if (!value || !path || !/^\d{1,3}$/u.test(value)) return null;
	const fd = Number(value);
	try {
		const file = fstatSync(fd);
		const named = lstatSync(path);
		const parent = lstatSync(dirname(path));
		if (
			!file.isFile() ||
			!named.isFile() ||
			named.isSymbolicLink() ||
			file.nlink !== 1 ||
			!privateInfo(file) ||
			!parent.isDirectory() ||
			parent.isSymbolicLink() ||
			!privateInfo(parent) ||
			file.dev !== named.dev ||
			file.ino !== named.ino
		)
			return null;
		return { fd, path };
	} catch {
		return null;
	}
}

/** Admission is acquired by the OS-only bootstrap, before any Electron or bundled Node code loads. */
export async function validateDesktopNativeAdmission(
	options: { appPath?: string; synthetic?: boolean; fd?: number } = {},
): Promise<DesktopAdmissionDescriptor | null> {
	const descriptor = getDesktopAdmissionDescriptor();
	const synthetic =
		options.synthetic === true &&
		(Boolean(process.env.QUARTERDECK_DESKTOP_LAB_CONFIG) || process.env.QUARTERDECK_AGENT_LAB === "1");
	if (synthetic && (!options.appPath || resolve(options.appPath) !== desktopStableAppPath()) && !descriptor)
		return null;
	if (
		!descriptor ||
		(options.fd !== undefined && descriptor.fd !== options.fd) ||
		(!synthetic && descriptor.path !== join(desktopInstallationRoot(), "admission.lock"))
	)
		throw new DesktopInstallationError(
			"incomplete_installation",
			"The app or helper did not enter through the native installation admission bootstrap. Quit Quarterdeck and repair the npm installation.",
		);
	return descriptor;
}

/** The parent retains the locked open-file description even if the short native child dies. */
export async function acquireDesktopMutation(bootstrap: string, lockPath: string): Promise<() => Promise<void>> {
	await ensureDesktopPrivateDirectory(dirname(lockPath));
	const file = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
	try {
		const info = await file.stat();
		const named = await lstat(lockPath);
		if (!info.isFile() || !privateInfo(info) || info.nlink !== 1 || info.dev !== named.dev || info.ino !== named.ino)
			throw new Error("Invalid lock");
		await new Promise<void>((accept, reject) => {
			const child = spawn(bootstrap, ["--quarterdeck-install-lock-fd", lockPath], {
				stdio: ["ignore", "ignore", "pipe", file.fd],
			});
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				if (stderr.length < 4096) stderr += chunk.toString();
			});
			child.once("error", reject);
			child.once("exit", (code) => (code === 0 ? accept() : reject(new Error(stderr))));
		});
		return async () => {
			await file.close();
		};
	} catch {
		await file.close();
		throw new DesktopInstallationError(
			"installation_in_use",
			"Quarterdeck is in use, another installation is running, or its admission lock could not be verified. Quit all Quarterdeck windows and helpers, then retry.",
		);
	}
}
