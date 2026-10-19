import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type DesktopInstallationOwner, desktopBuildsMatch } from "../shared/desktop-installation-contract.js";
import { inspectDesktopApp } from "./app-identity.js";
import { DesktopInstallationError } from "./errors.js";
import { desktopFileSha256, readDesktopJson } from "./files.js";
import { verifyDesktopDeveloperSignature } from "./macos.js";
import {
	type DesktopReleaseManifest,
	desktopContainerName,
	maximumDesktopManifestBytes,
	validateDesktopReleaseManifest,
} from "./metadata.js";
import { desktopReleaseAssetUrl } from "./network.js";
import {
	desktopApplicationBundleId,
	desktopLaunchProtocolVersion,
	type ManagedDesktopInstallationReceipt,
} from "./receipt.js";
import { writeDesktopJson } from "./transaction-files.js";
import type {
	DesktopInstallationArchitecture,
	DesktopInstallationDependencies,
	EnsureDesktopInstallationOptions,
} from "./types.js";

export async function prepareDesktopInstallation(
	stage: string,
	appPath: string,
	owner: DesktopInstallationOwner,
	options: EnsureDesktopInstallationOptions,
	arch: DesktopInstallationArchitecture,
	dependencies: DesktopInstallationDependencies,
) {
	const mountpoint = join(stage, "mount");
	let mounted = false;
	const progress = (phase: "downloading" | "verifying" | "copying", message: string) => {
		try {
			options.onProgress?.({ phase, message });
		} catch {
			/* Presentation never owns commit. */
		}
	};
	async function detach() {
		try {
			await dependencies.runCommand("/usr/bin/hdiutil", ["detach", mountpoint]);
		} catch {
			if ((await lstat(mountpoint)).dev !== (await lstat(stage)).dev) {
				await writeDesktopJson(join(stage, "retain-mounted-stage.json"), { schemaVersion: 1 });
				throw new DesktopInstallationError(
					"incomplete_installation",
					`The private mount at ${mountpoint} could not be detached. Staging was retained safely.`,
				);
			}
		}
		mounted = false;
	}
	try {
		let sourceApp: string;
		let release: DesktopReleaseManifest | undefined;
		let provenance: ManagedDesktopInstallationReceipt["release"] = null;
		if (options.from !== undefined) sourceApp = resolve(options.from);
		else {
			progress("downloading", `Downloading Quarterdeck v${options.version} for darwin-${arch}.`);
			const manifestPath = join(stage, "release-manifest.json");
			await dependencies.download(
				desktopReleaseAssetUrl(options.version, `artifact-manifest-darwin-${arch}.json`),
				manifestPath,
				maximumDesktopManifestBytes,
			);
			release = validateDesktopReleaseManifest(await readDesktopJson(manifestPath), options.version, arch);
			const name = desktopContainerName(options.version, arch);
			const artifact = release.artifacts.find((candidate) => candidate.path === name);
			if (!artifact) throw new DesktopInstallationError("invalid_artifact", "The matching desktop DMG is missing.");
			const container = join(stage, name);
			await dependencies.download(desktopReleaseAssetUrl(options.version, name), container, artifact.bytes);
			const info = await lstat(container);
			if (!info.isFile() || info.size !== artifact.bytes || (await desktopFileSha256(container)) !== artifact.sha256)
				throw new DesktopInstallationError(
					"invalid_artifact",
					"The desktop DMG checksum or byte length does not match the release manifest.",
				);
			await mkdir(mountpoint, { mode: 0o700 });
			mounted = true;
			await dependencies.runCommand("/usr/bin/hdiutil", [
				"attach",
				"-readonly",
				"-nobrowse",
				"-noautoopen",
				"-mountpoint",
				mountpoint,
				"-plist",
				container,
			]);
			sourceApp = join(mountpoint, "Quarterdeck.app");
			provenance = {
				manifestSha256: await desktopFileSha256(manifestPath),
				containerName: name,
				containerSha256: artifact.sha256,
				sourceSha: release.sourceSha,
			};
		}
		progress("verifying", "Verifying the matching CLI and desktop identities.");
		const identity = await inspectDesktopApp(sourceApp, options.version, arch, dependencies, release);
		if (!desktopBuildsMatch(owner, identity.bundle, options.from === undefined ? "release" : "local"))
			throw new DesktopInstallationError(
				"invalid_artifact",
				"The app and owning npm CLI have different source or local build identities. Build the pair together, or reinstall the matching npm release.",
			);
		if (release?.expectedTeamId)
			await verifyDesktopDeveloperSignature(identity.appPath, release.expectedTeamId, dependencies.runCommand);
		progress("copying", "Preparing the verified replacement before checking whether Quarterdeck is in use.");
		const stagedApp = join(stage, "Quarterdeck.app");
		await dependencies.runCommand("/usr/bin/ditto", [identity.appPath, stagedApp]);
		const copy = await inspectDesktopApp(stagedApp, options.version, arch, dependencies, release);
		if (copy.appTreeSha256 !== identity.appTreeSha256)
			throw new DesktopInstallationError("invalid_artifact", "The source app changed or its copy is incomplete.");
		if (release?.expectedTeamId)
			await verifyDesktopDeveloperSignature(copy.appPath, release.expectedTeamId, dependencies.runCommand);
		const receipt: ManagedDesktopInstallationReceipt = {
			schemaVersion: 2,
			managedBy: "quarterdeck-npm",
			installId: randomUUID(),
			version: options.version,
			arch,
			source: release ? "release" : "local",
			appPath,
			bundleId: desktopApplicationBundleId,
			buildId: copy.bundle.buildId,
			appAsarSha256: copy.appAsarSha256,
			appTreeSha256: copy.appTreeSha256,
			desktopLaunchProtocolVersion,
			updatesEnabled: false,
			owner,
			signing: { verified: Boolean(release), teamId: release?.expectedTeamId ?? null },
			release: provenance,
		};
		await writeDesktopJson(join(stage, "receipt.json"), receipt);
		if (mounted) await detach();
		return { receipt, stagedApp, bootstrap: join(stagedApp, "Contents/Resources/runtime/installation-admission") };
	} catch (error) {
		if (mounted) await detach();
		throw error;
	} finally {
		if (!mounted) await rm(mountpoint, { recursive: true, force: true });
	}
}
