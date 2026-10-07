import { z } from "zod";
import { DesktopInstallationError } from "./errors.js";
import {
	desktopArchitectureSchema,
	desktopLaunchProtocolVersion,
	desktopSha256Schema,
	desktopVersionSchema,
} from "./receipt.js";
import type { DesktopInstallationArchitecture } from "./types.js";

export const maximumDesktopManifestBytes = 128 * 1024;
export const maximumDesktopContainerBytes = 1024 * 1024 * 1024;
export const desktopResourcePaths = [
	"app.asar",
	"runtime/bin/node",
	"runtime/dist/cli.js",
	"runtime/dist/web-ui/index.html",
	"runtime/bundle-manifest.json",
	"runtime/release-policy.json",
] as const;

const bundleSchema = z.object({
	schemaVersion: z.literal(1),
	platform: z.literal("darwin"),
	arch: desktopArchitectureSchema,
	version: desktopVersionSchema,
	buildId: z.uuid(),
	sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
	sourceDirty: z.boolean(),
	desktopLaunchProtocolVersion: z.literal(desktopLaunchProtocolVersion),
	signedDistribution: z.boolean(),
	expectedTeamId: z
		.string()
		.regex(/^[A-Z0-9]{10}$/u)
		.nullable(),
	productionUpdatesEnabled: z.boolean(),
	channel: z.enum(["stable", "preview", "validation"]),
	validationFeedBase: z.string().max(2048).nullable(),
	electronVersion: desktopVersionSchema,
	nodeVersion: desktopVersionSchema,
	nodeAbi: z.string().regex(/^\d{1,4}$/u),
	minimumMacOSVersion: z
		.string()
		.max(20)
		.regex(/^\d+\.\d+(?:\.\d+)?$/u),
	runtimeLockSha256: desktopSha256Schema,
	nodeArchive: z.object({ filename: z.string().max(200), sha256: desktopSha256Schema }),
});

const releaseManifestSchema = bundleSchema.extend({
	distribution: z.literal("signed-notarized"),
	fuses: z.object({
		RunAsNode: z.literal(false),
		EnableNodeOptionsEnvironmentVariable: z.literal(false),
		EnableNodeCliInspectArguments: z.literal(false),
		EnableCookieEncryption: z.literal(true),
		EnableEmbeddedAsarIntegrityValidation: z.literal(true),
		OnlyLoadAppFromAsar: z.literal(true),
		GrantFileProtocolExtraPrivileges: z.literal(false),
	}),
	checksums: z.record(z.string().max(200), desktopSha256Schema),
	artifacts: z
		.array(
			z.object({
				path: z.string().max(200),
				bytes: z.number().int().positive().max(maximumDesktopContainerBytes),
				sha256: desktopSha256Schema,
			}),
		)
		.max(8),
});

export type DesktopBundleMetadata = z.infer<typeof bundleSchema>;
export type DesktopReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function validateDesktopBundleMetadata(
	raw: unknown,
	version: string,
	arch: DesktopInstallationArchitecture,
): DesktopBundleMetadata {
	const parsed = bundleSchema.safeParse(raw);
	if (!parsed.success) {
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The app has missing or invalid desktop metadata. Build a fresh matching app with npm desktop launch support, then import it with --from.",
		);
	}
	if (parsed.data.version !== version || parsed.data.arch !== arch) {
		throw new DesktopInstallationError(
			"invalid_artifact",
			`The app must match npm version ${version} and darwin-${arch}.`,
		);
	}
	return parsed.data;
}

export function validateDesktopReleaseManifest(
	raw: unknown,
	version: string,
	arch: DesktopInstallationArchitecture,
): DesktopReleaseManifest {
	const parsed = releaseManifestSchema.safeParse(raw);
	if (!parsed.success)
		throw new DesktopInstallationError("invalid_artifact", "The desktop release manifest is invalid.");
	const manifest = parsed.data;
	const stable = !version.includes("-");
	if (
		manifest.version !== version ||
		manifest.arch !== arch ||
		manifest.sourceDirty ||
		!manifest.signedDistribution ||
		manifest.expectedTeamId === null ||
		manifest.channel !== (stable ? "stable" : "preview") ||
		manifest.validationFeedBase !== null ||
		manifest.productionUpdatesEnabled !== stable ||
		desktopResourcePaths.some((path) => !manifest.checksums[path])
	) {
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The desktop release identity or signed release policy does not match this npm version.",
		);
	}
	const name = desktopContainerName(version, arch);
	if (manifest.artifacts.filter((artifact) => artifact.path === name).length !== 1) {
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The release manifest does not contain the exact matching macOS DMG.",
		);
	}
	return manifest;
}

export function desktopContainerName(version: string, arch: DesktopInstallationArchitecture): string {
	return `Quarterdeck-${version}-darwin-${arch}.dmg`;
}
