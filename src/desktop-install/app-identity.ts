import { join } from "node:path";
import { z } from "zod";
import { desktopBuildIdentitySchema } from "../shared/desktop-installation-contract.js";
import { DesktopInstallationError } from "./errors.js";
import { desktopAppTreeSha256, desktopFileSha256, desktopPhysicalFileSystem, readDesktopJson } from "./files.js";
import {
	type DesktopBundleMetadata,
	type DesktopReleaseManifest,
	desktopResourcePaths,
	validateDesktopBundleMetadata,
} from "./metadata.js";
import { desktopApplicationBundleId } from "./receipt.js";
import type { DesktopInstallationArchitecture, DesktopInstallationDependencies } from "./types.js";

const { lstat, realpath } = desktopPhysicalFileSystem;

const applicationInfoSchema = z.object({
	CFBundleIdentifier: z.literal(desktopApplicationBundleId),
	CFBundleShortVersionString: z.string(),
	CFBundleExecutable: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[\w .-]+$/u),
});

export interface DesktopAppIdentity {
	appPath: string;
	bundle: DesktopBundleMetadata;
	appAsarSha256: string;
	appTreeSha256: string;
}

export async function inspectDesktopApp(
	appPath: string,
	version: string,
	arch: DesktopInstallationArchitecture,
	dependencies: Pick<DesktopInstallationDependencies, "runCommand">,
	release?: DesktopReleaseManifest,
): Promise<DesktopAppIdentity> {
	if (!appPath.endsWith(".app"))
		throw new DesktopInstallationError(
			"invalid_artifact",
			"Pass an explicit Quarterdeck .app directory with --from.",
		);
	const canonicalAppPath = await realpath(appPath);
	const appTreeSha256 = await desktopAppTreeSha256(canonicalAppPath);
	const plistPath = join(canonicalAppPath, "Contents/Info.plist");
	const plist = await lstat(plistPath);
	if (!plist.isFile() || plist.size > 128 * 1024)
		throw new DesktopInstallationError("invalid_artifact", "The app's Info.plist is invalid.");
	const { stdout } = await dependencies.runCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]);
	let rawInfo: unknown;
	try {
		rawInfo = JSON.parse(stdout) as unknown;
	} catch {
		throw new DesktopInstallationError("invalid_artifact", "The app's Info.plist could not be decoded.");
	}
	const parsedInfo = applicationInfoSchema.safeParse(rawInfo);
	if (!parsedInfo.success || parsedInfo.data.CFBundleShortVersionString !== version) {
		throw new DesktopInstallationError("invalid_artifact", `The app must be Quarterdeck version ${version}.`);
	}
	const resources = join(canonicalAppPath, "Contents/Resources");
	const bundle = validateDesktopBundleMetadata(
		await readDesktopJson(join(resources, "runtime/bundle-manifest.json")),
		version,
		arch,
	);
	const runtimeIdentity = desktopBuildIdentitySchema.safeParse(
		await readDesktopJson(join(resources, "runtime/dist/build-manifest.json"), 4096),
	);
	if (
		!runtimeIdentity.success ||
		runtimeIdentity.data.version !== bundle.version ||
		runtimeIdentity.data.buildId !== bundle.buildId ||
		runtimeIdentity.data.sourceSha !== bundle.sourceSha ||
		runtimeIdentity.data.sourceDirty !== bundle.sourceDirty
	)
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The bundled runtime build identity differs from its app.",
		);
	const policyResult = z
		.record(z.string(), z.unknown())
		.safeParse(await readDesktopJson(join(resources, "runtime/release-policy.json")));
	if (
		!policyResult.success ||
		policyResult.data.schemaVersion !== 1 ||
		policyResult.data.repository !== "dankhole/quarterdeck"
	) {
		throw new DesktopInstallationError("invalid_artifact", "The app's embedded release policy is invalid.");
	}
	const policy = policyResult.data;
	for (const field of [
		"version",
		"arch",
		"buildId",
		"sourceSha",
		"signedDistribution",
		"expectedTeamId",
		"updateAuthority",
		"channel",
	] as const) {
		if (!(field in policy) || policy[field] !== bundle[field]) {
			throw new DesktopInstallationError(
				"invalid_artifact",
				"The app's embedded policy does not match its runtime identity.",
			);
		}
	}
	const binaries = [
		join(canonicalAppPath, "Contents/MacOS", parsedInfo.data.CFBundleExecutable),
		join(canonicalAppPath, "Contents/MacOS/QuarterdeckHost"),
		join(resources, "runtime/installation-admission"),
		join(resources, "runtime/bin/node"),
		join(resources, "runtime/bin/nodeHost"),
		join(resources, "runtime/node_modules/node-pty/build/Release/pty.node"),
	];
	for (const binary of binaries) {
		if (!(await lstat(binary)).isFile())
			throw new DesktopInstallationError("invalid_artifact", "A required app binary is not a regular file.");
		const result = await dependencies.runCommand("/usr/bin/lipo", ["-archs", binary]);
		if (result.stdout.trim() !== (arch === "arm64" ? "arm64" : "x86_64")) {
			throw new DesktopInstallationError("invalid_artifact", `The app's native binaries must match darwin-${arch}.`);
		}
	}
	if (
		release &&
		((await desktopFileSha256(join(canonicalAppPath, "Contents/MacOS", parsedInfo.data.CFBundleExecutable))) !==
			release.nativeAdmission.bootstrapSha256 ||
			(await desktopFileSha256(join(canonicalAppPath, "Contents/MacOS/QuarterdeckHost"))) !==
				release.nativeAdmission.hostSha256)
	)
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The native admission bootstrap or Electron host does not match the release manifest.",
		);
	for (const resource of desktopResourcePaths) {
		const path = join(resources, resource);
		if (!(await lstat(path)).isFile())
			throw new DesktopInstallationError("invalid_artifact", "A required app resource is not a regular file.");
		if (release && (await desktopFileSha256(path)) !== release.checksums[resource]) {
			throw new DesktopInstallationError(
				"invalid_artifact",
				"The app resource checksums do not match the trusted release manifest.",
			);
		}
	}
	if (release) {
		for (const field of Object.keys(bundle) as Array<keyof DesktopBundleMetadata>) {
			if (JSON.stringify(bundle[field]) !== JSON.stringify(release[field])) {
				throw new DesktopInstallationError(
					"invalid_artifact",
					"The bundled runtime provenance differs from the trusted release manifest.",
				);
			}
		}
	}
	return {
		appPath: canonicalAppPath,
		bundle,
		appAsarSha256: await desktopFileSha256(join(resources, "app.asar")),
		appTreeSha256,
	};
}
