import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isNodeError } from "../fs/node-error.js";
import { type DesktopAppIdentity, inspectDesktopApp } from "./app-identity.js";
import { DesktopInstallationError } from "./errors.js";
import { desktopFileSha256, readDesktopJson, setDesktopTreeWritable } from "./files.js";
import { runDesktopInstallCommand, verifyDesktopDeveloperSignature } from "./macos.js";
import {
	type DesktopReleaseManifest,
	desktopContainerName,
	maximumDesktopManifestBytes,
	validateDesktopReleaseManifest,
} from "./metadata.js";
import { desktopReleaseAssetUrl, downloadDesktopAsset } from "./network.js";
import {
	desktopApplicationBundleId,
	desktopLaunchProtocolVersion,
	desktopVersionSchema,
	type ManagedDesktopInstallationReceipt,
	managedDesktopInstallationReceiptFilename,
	managedDesktopInstallationReceiptSchema,
	managedDesktopSelectionSchema,
} from "./receipt.js";
import type {
	DesktopInstallation,
	DesktopInstallationArchitecture,
	DesktopInstallationDependencies,
	EnsureDesktopInstallationOptions,
} from "./types.js";

export { DesktopInstallationError } from "./errors.js";
export type { DesktopInstallation, DesktopInstallationProgress, EnsureDesktopInstallationOptions } from "./types.js";

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value, null, "\t")}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
}

async function existingPath(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return false;
		throw error;
	}
}

function installationResult(
	identity: DesktopAppIdentity,
	receipt: ManagedDesktopInstallationReceipt,
	receiptPath: string,
): DesktopInstallation {
	return {
		appPath: identity.appPath,
		version: receipt.version,
		arch: receipt.arch,
		source: receipt.source,
		installId: receipt.installId,
		buildId: receipt.buildId,
		appAsarSha256: receipt.appAsarSha256,
		receiptPath,
	};
}

/** Tests inject a private temporary root and OS/download effects; production has no root override. */
export function createDesktopInstallationService(dependencies: DesktopInstallationDependencies) {
	async function readSelected(
		root: string,
		pointer: string,
		version: string,
		arch: DesktopInstallationArchitecture,
	): Promise<DesktopInstallation | null> {
		if (!(await existingPath(pointer))) return null;
		const selection = managedDesktopSelectionSchema.safeParse(await readDesktopJson(pointer, 1024));
		if (!selection.success)
			throw new DesktopInstallationError(
				"installation_changed",
				"The selected desktop installation is invalid. Import a fresh matching app with --from.",
			);
		const slot = join(root, "installations", selection.data.installId);
		const slotInfo = await lstat(slot);
		if (!slotInfo.isDirectory() || slotInfo.isSymbolicLink())
			throw new DesktopInstallationError("installation_changed", "The selected desktop directory was replaced.");
		const receiptPath = join(slot, managedDesktopInstallationReceiptFilename);
		const receiptResult = managedDesktopInstallationReceiptSchema.safeParse(await readDesktopJson(receiptPath));
		if (
			!receiptResult.success ||
			receiptResult.data.installId !== selection.data.installId ||
			receiptResult.data.version !== version ||
			receiptResult.data.arch !== arch
		) {
			throw new DesktopInstallationError(
				"installation_changed",
				"The selected desktop receipt does not match this npm version and architecture. Import a matching app with --from.",
			);
		}
		const receipt = receiptResult.data;
		let release: DesktopReleaseManifest | undefined;
		if (receipt.release) {
			const manifestPath = join(slot, "release-manifest.json");
			const rawManifest = await readDesktopJson(manifestPath);
			if ((await desktopFileSha256(manifestPath)) !== receipt.release.manifestSha256)
				throw new DesktopInstallationError("installation_changed", "The retained release manifest changed.");
			release = validateDesktopReleaseManifest(rawManifest, version, arch);
			if (release.expectedTeamId !== receipt.signing.teamId || release.sourceSha !== receipt.release.sourceSha)
				throw new DesktopInstallationError("installation_changed", "The retained signing identity changed.");
		}
		const selectedApp = join(slot, receipt.appPath);
		const appInfo = await lstat(selectedApp);
		if (!appInfo.isDirectory() || appInfo.isSymbolicLink())
			throw new DesktopInstallationError(
				"installation_changed",
				"The selected managed app was replaced by a link or non-directory.",
			);
		const identity = await inspectDesktopApp(selectedApp, version, arch, dependencies, release);
		if (
			identity.appTreeSha256 !== receipt.appTreeSha256 ||
			identity.appAsarSha256 !== receipt.appAsarSha256 ||
			identity.bundle.buildId !== receipt.buildId
		) {
			throw new DesktopInstallationError(
				"installation_changed",
				"The managed app changed after installation. It was retained; import a fresh matching app with --from.",
			);
		}
		if (receipt.signing.verified && receipt.signing.teamId)
			await verifyDesktopDeveloperSignature(identity.appPath, receipt.signing.teamId, dependencies.runCommand);
		return installationResult(identity, receipt, receiptPath);
	}

	async function ensureDesktopInstallation(options: EnsureDesktopInstallationOptions): Promise<DesktopInstallation> {
		if (dependencies.platform !== "darwin" || !["arm64", "x64"].includes(dependencies.arch)) {
			throw new DesktopInstallationError(
				"unsupported_platform",
				"The optional Quarterdeck app requires native macOS arm64 or x64. Browser mode remains available.",
			);
		}
		if (!desktopVersionSchema.safeParse(options.version).success)
			throw new DesktopInstallationError(
				"invalid_version",
				"Desktop installation requires an exact npm version without build metadata.",
			);
		if (options.from !== undefined && options.from.length === 0)
			throw new DesktopInstallationError(
				"invalid_artifact",
				"The --from option requires an explicit Quarterdeck .app path.",
			);
		const arch = dependencies.arch as DesktopInstallationArchitecture;
		const rootPath = resolve(dependencies.managedRoot);
		await mkdir(rootPath, { recursive: true, mode: 0o700 });
		if (!(await lstat(rootPath)).isDirectory() || (await lstat(rootPath)).isSymbolicLink())
			throw new DesktopInstallationError(
				"installation_changed",
				"The managed desktop root must be a real directory.",
			);
		const root = await realpath(rootPath);
		for (const name of ["installations", "selections"]) {
			const path = join(root, name);
			await mkdir(path, { recursive: true, mode: 0o700 });
			const metadata = await lstat(path);
			if (!metadata.isDirectory() || metadata.isSymbolicLink())
				throw new DesktopInstallationError("installation_changed", "A managed desktop directory was replaced.");
		}
		const pointer = join(root, "selections", `${options.version}-darwin-${arch}.json`);
		const progress = (
			phase: Parameters<NonNullable<EnsureDesktopInstallationOptions["onProgress"]>>[0]["phase"],
			message: string,
		) => {
			// A presentation callback cannot turn a completed atomic selection into a failed install.
			try {
				options.onProgress?.({ phase, message });
			} catch {
				/* Installation owns its outcome. */
			}
		};
		progress("resolving", `Resolving Quarterdeck ${options.version} for darwin-${arch}.`);
		if (options.from === undefined) {
			const selected = await readSelected(root, pointer, options.version, arch);
			if (selected) {
				progress("installed", `Quarterdeck ${options.version} is installed (${selected.source}).`);
				return selected;
			}
		}
		const stage = await mkdtemp(join(root, ".install-"));
		let mounted = false;
		const mountpoint = join(stage, "mount");
		const installId = randomUUID();
		const stagedSlot = join(stage, "installation");
		let promoted = false;
		let pointerTemporary: string | undefined;
		async function detachOwnedMount(): Promise<void> {
			try {
				await dependencies.runCommand("/usr/bin/hdiutil", ["detach", mountpoint]);
			} catch {
				// Attach may fail after mounting, or detach may report an already-absent mount.
				// Never recursively remove a mounted filesystem when detach cannot be confirmed.
				if ((await lstat(mountpoint)).dev !== (await lstat(stage)).dev)
					throw new DesktopInstallationError(
						"command_failed",
						`macOS could not detach the private installer mount at ${mountpoint}. The staging directory was retained and no new app was selected.`,
					);
			}
			mounted = false;
		}
		try {
			await mkdir(stagedSlot, { mode: 0o700 });
			let sourceApp: string;
			let release: DesktopReleaseManifest | undefined;
			let releaseProvenance: ManagedDesktopInstallationReceipt["release"] = null;
			if (options.from !== undefined) {
				sourceApp = resolve(options.from);
			} else {
				progress("downloading", `Downloading the exact v${options.version} desktop release.`);
				const manifestName = `artifact-manifest-darwin-${arch}.json`;
				const manifestPath = join(stagedSlot, "release-manifest.json");
				try {
					await dependencies.download(
						desktopReleaseAssetUrl(options.version, manifestName),
						manifestPath,
						maximumDesktopManifestBytes,
					);
				} catch (error) {
					if (error instanceof DesktopInstallationError && error.code === "release_unavailable")
						throw new DesktopInstallationError(
							"release_unavailable",
							`No desktop release v${options.version} for darwin-${arch} is published. Build the matching desktop app and import it with --from /path/to/Quarterdeck.app.`,
						);
					throw error;
				}
				release = validateDesktopReleaseManifest(await readDesktopJson(manifestPath), options.version, arch);
				const name = desktopContainerName(options.version, arch);
				const artifact = release.artifacts.find((candidate) => candidate.path === name);
				if (!artifact)
					throw new DesktopInstallationError("invalid_artifact", "The matching desktop DMG is missing.");
				const containerPath = join(stage, name);
				await dependencies.download(desktopReleaseAssetUrl(options.version, name), containerPath, artifact.bytes);
				const containerInfo = await lstat(containerPath);
				if (
					!containerInfo.isFile() ||
					containerInfo.size !== artifact.bytes ||
					(await desktopFileSha256(containerPath)) !== artifact.sha256
				) {
					throw new DesktopInstallationError(
						"invalid_artifact",
						"The desktop DMG checksum or byte length does not match the trusted manifest.",
					);
				}
				await mkdir(mountpoint, { mode: 0o700 });
				// A failed attach can still leave a mounted volume, so cleanup owns the attempt.
				mounted = true;
				await dependencies.runCommand("/usr/bin/hdiutil", [
					"attach",
					"-readonly",
					"-nobrowse",
					"-noautoopen",
					"-mountpoint",
					mountpoint,
					"-plist",
					containerPath,
				]);
				sourceApp = join(mountpoint, "Quarterdeck.app");
				releaseProvenance = {
					manifestSha256: await desktopFileSha256(manifestPath),
					containerName: name,
					containerSha256: artifact.sha256,
					sourceSha: release.sourceSha,
				};
			}
			progress("verifying", "Verifying the app's exact version, architecture, and launch capability.");
			const sourceIdentity = await inspectDesktopApp(sourceApp, options.version, arch, dependencies, release);
			if (release?.expectedTeamId)
				await verifyDesktopDeveloperSignature(
					sourceIdentity.appPath,
					release.expectedTeamId,
					dependencies.runCommand,
				);
			progress("copying", "Copying into a private immutable managed installation.");
			const stagedApp = join(stagedSlot, "Quarterdeck.app");
			await dependencies.runCommand("/usr/bin/ditto", [sourceIdentity.appPath, stagedApp]);
			const copiedIdentity = await inspectDesktopApp(stagedApp, options.version, arch, dependencies, release);
			if (copiedIdentity.appTreeSha256 !== sourceIdentity.appTreeSha256)
				throw new DesktopInstallationError("invalid_artifact", "The source app changed or its copy is incomplete.");
			if (release?.expectedTeamId)
				await verifyDesktopDeveloperSignature(
					copiedIdentity.appPath,
					release.expectedTeamId,
					dependencies.runCommand,
				);
			if (mounted) {
				await detachOwnedMount();
			}
			const receipt: ManagedDesktopInstallationReceipt = {
				schemaVersion: 1,
				managedBy: "quarterdeck-npm",
				installId,
				version: options.version,
				arch,
				source: release ? "release" : "local",
				appPath: "Quarterdeck.app",
				bundleId: desktopApplicationBundleId,
				buildId: copiedIdentity.bundle.buildId,
				appAsarSha256: copiedIdentity.appAsarSha256,
				appTreeSha256: copiedIdentity.appTreeSha256,
				desktopLaunchProtocolVersion,
				updatesEnabled: false,
				signing: { verified: Boolean(release), teamId: release?.expectedTeamId ?? null },
				release: releaseProvenance,
			};
			await writePrivateJson(join(stagedSlot, managedDesktopInstallationReceiptFilename), receipt);
			await setDesktopTreeWritable(stagedSlot, false);
			// macOS needs write permission on a directory whose parent changes during rename.
			// The copied app remains read-only; freeze the slot itself before selecting it.
			await chmod(stagedSlot, 0o700);
			const slot = join(root, "installations", installId);
			if (await existingPath(slot))
				throw new DesktopInstallationError(
					"installation_changed",
					"The unique desktop installation ID is already occupied.",
				);
			await rename(stagedSlot, slot);
			promoted = true;
			await chmod(slot, 0o500);
			const identity = { ...copiedIdentity, appPath: await realpath(join(slot, "Quarterdeck.app")) };
			const result = installationResult(identity, receipt, join(slot, managedDesktopInstallationReceiptFilename));
			pointerTemporary = join(root, "selections", `.selection-${randomUUID()}.json`);
			await writePrivateJson(pointerTemporary, { schemaVersion: 1, installId });
			await rename(pointerTemporary, pointer);
			pointerTemporary = undefined;
			progress("installed", `Quarterdeck ${options.version} is installed (${receipt.source}).`);
			return result;
		} finally {
			if (mounted) await detachOwnedMount();
			if (pointerTemporary) await rm(pointerTemporary, { force: true });
			// Only our unique staging tree is removed. Promoted installations are never pruned.
			if (!promoted && (await existingPath(stagedSlot))) await setDesktopTreeWritable(stagedSlot, true);
			await rm(stage, { recursive: true, force: true });
		}
	}
	return { ensureDesktopInstallation };
}

const productionService = createDesktopInstallationService({
	platform: process.platform,
	arch: process.arch,
	managedRoot: join(homedir(), "Library/Application Support/Quarterdeck/managed-apps"),
	runCommand: runDesktopInstallCommand,
	download: downloadDesktopAsset,
});

export const ensureDesktopInstallation = productionService.ensureDesktopInstallation;
