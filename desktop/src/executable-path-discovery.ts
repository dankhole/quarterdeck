import { constants } from "node:fs";
import { access, open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_NVM_DIRECTORY_ENTRIES = 512;
const MAX_ALIAS_BYTES = 1024;
const MAX_ALIAS_HOPS = 8;

/** Fixed, bounded filesystem operations only; discovery never executes an installed command. */
export interface DesktopExecutableDiscoveryFileSystem {
	isDirectory: (path: string) => Promise<boolean>;
	isExecutableFile: (path: string) => Promise<boolean>;
	readDirectory: (path: string, maxEntries: number) => Promise<string[] | null>;
	readRegularFile: (path: string, maxBytes: number) => Promise<string | null>;
}

export interface DesktopExecutableDiscoveryDependencies {
	getHomeDirectory?: () => string;
	fileSystem?: DesktopExecutableDiscoveryFileSystem;
}

function isPathDirectory(path: string | undefined): path is string {
	return path !== undefined && isAbsolute(path) && !/[:\0\r\n]/u.test(path);
}

const fileSystem: DesktopExecutableDiscoveryFileSystem = {
	async isDirectory(path) {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	},
	async isExecutableFile(path) {
		try {
			if (!(await stat(path)).isFile()) return false;
			await access(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
	async readDirectory(path, maxEntries) {
		try {
			const directory = await opendir(path);
			try {
				const names: string[] = [];
				for (let count = 0; count <= maxEntries; count += 1) {
					const entry = await directory.read();
					if (!entry) return names;
					if (count === maxEntries) return null;
					names.push(entry.name);
				}
				return null;
			} finally {
				await directory.close();
			}
		} catch {
			return null;
		}
	},
	async readRegularFile(path, maxBytes) {
		try {
			// Reject symlinks and special files without blocking on a FIFO or device.
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const metadata = await file.stat();
				if (!metadata.isFile() || metadata.size === 0 || metadata.size > maxBytes) return null;
				const bytes = Buffer.alloc(maxBytes + 1);
				const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
				if (bytesRead !== metadata.size || bytesRead > maxBytes) return null;
				return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
			} finally {
				await file.close();
			}
		} catch {
			return null;
		}
	},
};

interface InstalledNodeVersion {
	name: string;
	components: number[];
}

function parseInstalledVersion(name: string): InstalledNodeVersion | null {
	const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(name);
	if (!match) return null;
	const components = match.slice(1).map(Number);
	return components.every(Number.isSafeInteger) ? { name, components } : null;
}

function compareVersionsDescending(left: InstalledNodeVersion, right: InstalledNodeVersion): number {
	for (let index = 0; index < 3; index += 1) {
		const difference = right.components[index] - left.components[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

/** Resolve nvm's default alias without interpreting shell syntax or following alias-file symlinks. */
async function resolveDefaultSelector(
	nvmDirectory: string,
	fs: DesktopExecutableDiscoveryFileSystem,
): Promise<string | null> {
	let selector = "default";
	const visited = new Set<string>();
	for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
		if (selector === "system" || selector === "node" || selector === "stable") return selector;
		if (/^v?\d+(?:\.\d+){0,2}$/u.test(selector)) return selector;
		if (
			visited.has(selector) ||
			!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*|lts\/(?:\*|[A-Za-z0-9][A-Za-z0-9._-]*))$/u.test(selector)
		)
			return null;
		visited.add(selector);
		const alias = await fs.readRegularFile(join(nvmDirectory, "alias", selector), MAX_ALIAS_BYTES);
		if (alias === null) return null;
		selector = alias.trim();
	}
	return null;
}

async function discoverNvmDirectory(
	nvmDirectory: string,
	fs: DesktopExecutableDiscoveryFileSystem,
): Promise<string | null> {
	const selector = await resolveDefaultSelector(nvmDirectory, fs);
	// An explicit system default must not be replaced by an arbitrary managed version.
	if (selector === "system") return null;
	const versionsDirectory = join(nvmDirectory, "versions", "node");
	const entries = await fs.readDirectory(versionsDirectory, MAX_NVM_DIRECTORY_ENTRIES);
	if (!entries) return null;
	const versions = entries.flatMap((entry) => {
		const version = parseInstalledVersion(entry);
		return version ? [version] : [];
	});
	versions.sort(compareVersionsDescending);
	const requested = selector?.replace(/^v/u, "").split(".").map(Number);
	const matches = requested?.every(Number.isSafeInteger)
		? versions.filter((version) => requested.every((component, index) => version.components[index] === component))
		: versions;
	for (const version of [...matches, ...versions.filter((version) => !matches.includes(version))]) {
		const bin = join(versionsDirectory, version.name, "bin");
		if ((await fs.isDirectory(bin)) && (await fs.isExecutableFile(join(bin, "node")))) return bin;
	}
	return null;
}

/** Add familiar user installation directories and at most one selected nvm installation. */
export async function discoverDesktopExecutableDirectories(
	environment: Readonly<NodeJS.ProcessEnv>,
	dependencies: DesktopExecutableDiscoveryDependencies = {},
): Promise<string[]> {
	const fs = dependencies.fileSystem ?? fileSystem;
	let homeDirectory = environment.HOME;
	if (!isPathDirectory(homeDirectory)) {
		try {
			homeDirectory = (dependencies.getHomeDirectory ?? homedir)();
		} catch {
			homeDirectory = undefined;
		}
	}
	const candidates = isPathDirectory(homeDirectory)
		? [join(homeDirectory, ".local", "bin"), join(homeDirectory, ".npm-global", "bin"), join(homeDirectory, "bin")]
		: [];
	const voltaDirectory = isPathDirectory(environment.VOLTA_HOME)
		? environment.VOLTA_HOME
		: isPathDirectory(homeDirectory)
			? join(homeDirectory, ".volta")
			: null;
	if (voltaDirectory) candidates.push(join(voltaDirectory, "bin"));
	const directories: string[] = [];
	for (const candidate of candidates) {
		if (await fs.isDirectory(candidate)) directories.push(candidate);
	}
	const nvmDirectory = isPathDirectory(environment.NVM_DIR)
		? environment.NVM_DIR
		: isPathDirectory(homeDirectory)
			? join(homeDirectory, ".nvm")
			: null;
	if (nvmDirectory) {
		const bin = await discoverNvmDirectory(nvmDirectory, fs);
		if (bin) directories.push(bin);
	}
	return Array.from(new Set(directories));
}
