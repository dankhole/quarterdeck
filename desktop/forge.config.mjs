import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { finalizeLocalAppSignature } from "./scripts/app-signature.mjs";
import { recordMakeArtifacts, recordPackagedApp } from "./scripts/artifact-manifest.mjs";
import { MakerDMG } from "./scripts/maker-dmg.mjs";
import { installDesktopNativeAdmission } from "./scripts/native-admission.mjs";
import { desktopRoot, requireNativeDesktopTarget, resolveTargetArch, stagedRuntimePath } from "./scripts/paths.mjs";
import { releaseBuildSettings } from "./scripts/release-policy.mjs";
import { copyRuntimeResource } from "./scripts/runtime-resources.mjs";
import { deferAdmissionExecutableToBundle, signingOptionsForFile } from "./scripts/signing-entitlements.mjs";
import { windowsDesktopIcon } from "./scripts/windows-icon.mjs";
import { installWindowsNativeAdmission } from "./scripts/windows-native-admission.mjs";

const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
const electronChecksums = JSON.parse(
	await readFile(join(desktopRoot, "node_modules", "electron", "checksums.json"), "utf8"),
);
const arch = resolveTargetArch(process.env.QUARTERDECK_DESKTOP_ARCH);
const windows = process.platform === "win32";
const runtimePath = stagedRuntimePath(arch);

// Public ad-hoc builds need no Apple credentials. Developer ID builds retain
// the protected temporary keychain/notarization lane; local candidates are
// resealed after packaging and may enable the isolated lab inspector.
const releaseSettings = releaseBuildSettings(process.env, desktopPackage.version);
const signing = releaseSettings.signedDistribution;
const notarizing = process.env.QUARTERDECK_DESKTOP_NOTARIZE === "1";
if (notarizing && !signing) throw new Error("Notarization requires explicit desktop signing.");
function requiredEnvironment(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Signed desktop builds require ${name}.`);
	return value;
}

export default {
	packagerConfig: {
		name: "Quarterdeck",
		appBundleId: desktopPackage.quarterdeckDesktop.bundleId,
		appCategoryType: "public.app-category.developer-tools",
		appVersion: desktopPackage.version,
		appCopyright: "Copyright © 2026 Quarterdeck contributors",
		icon: windows ? await windowsDesktopIcon() : join(desktopRoot, "assets", "quarterdeck.icns"),
		asar: true,
		afterCopy: [async ({ buildPath }) => copyRuntimeResource(runtimePath, buildPath)],
		// Packager renames Electron and applies fuses before this hook, then signs
		// the completed app. An empty extraResource list still enables the hook.
		extraResource: [],
		afterCopyExtraResources: [
			async ({ buildPath }) => {
				if (!windows) await installDesktopNativeAdmission(join(buildPath, "Quarterdeck.app"));
			},
		],
		ignore: [/^\/(?!dist(?:\/|$)|package\.json$)/u],
		// Match install-electron's cache and pinned checksums so packaging can reuse
		// the verified archive without downloading it or a fresh checksum file again.
		download: { cacheRoot: process.env.electron_config_cache, checksums: electronChecksums },
		extendInfo: { LSMinimumSystemVersion: desktopPackage.quarterdeckDesktop.minimumMacOSVersion },
		...(!windows && releaseSettings.distributionMode !== "local"
			? {
					osxSign: {
						identity: signing ? requiredEnvironment("QUARTERDECK_DESKTOP_SIGNING_IDENTITY") : "-",
						...(signing
							? { keychain: requiredEnvironment("QUARTERDECK_DESKTOP_SIGNING_KEYCHAIN") }
							: { identityValidation: false }),
						continueOnError: false,
						// The wrapper is signed by its .app seal after its sibling Host. Signing
						// it early would seal an Intel bundle while that Host is still unsigned.
						ignore: [deferAdmissionExecutableToBundle],
						// Never inherit osx-sign's broad default device/plugin grants.
						preAutoEntitlements: false,
						preEmbedProvisioningProfile: false,
						optionsForFile: (filePath) => signingOptionsForFile(filePath, releaseSettings.distributionMode),
					},
				}
			: {}),
		...(notarizing
			? {
					osxNotarize: {
						keychain: requiredEnvironment("QUARTERDECK_DESKTOP_SIGNING_KEYCHAIN"),
						keychainProfile: requiredEnvironment("QUARTERDECK_DESKTOP_NOTARY_PROFILE"),
					},
				}
			: {}),
	},
	// The real Node helper owns node-pty. Never rebuild that resource for Electron.
	rebuildConfig: { onlyModules: [] },
	plugins: [
		new FusesPlugin({
			version: FuseVersion.V1,
			// Seal only after Packager's final mutations (osxSign or postPackage).
			resetAdHocDarwinSignature: false,
			strictlyRequireAllFuses: true,
			[FuseV1Options.RunAsNode]: false,
			[FuseV1Options.EnableCookieEncryption]: true,
			[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
			// Only local lab candidates permit Playwright's inspector transport.
			[FuseV1Options.EnableNodeCliInspectArguments]: releaseSettings.distributionMode === "local",
			[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
			[FuseV1Options.OnlyLoadAppFromAsar]: true,
			[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
			[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
			[FuseV1Options.WasmTrapHandlers]: true,
		}),
	],
	makers: [
		...(windows ? [] : [new MakerDMG({ name: `Quarterdeck-${desktopPackage.version}-${arch}` })]),
		{ name: "@electron-forge/maker-zip", platforms: ["darwin", "win32"], config: {} },
	],
	publishers: [],
	hooks: {
		prePackage: async (_config, platform, targetArch) => {
			requireNativeDesktopTarget(targetArch);
			if (platform !== process.platform || targetArch !== arch)
				throw new Error(
					"Forge target differs from the staged native runtime. Use the desktop npm packaging commands.",
				);
			const manifest = JSON.parse(await readFile(join(runtimePath, "bundle-manifest.json"), "utf8"));
			if (manifest.platform !== platform || manifest.arch !== arch || manifest.version !== desktopPackage.version)
				throw new Error("Staged runtime is stale. Use the desktop npm packaging commands.");
			for (const [key, value] of Object.entries(releaseSettings)) {
				if (manifest[key] !== value)
					throw new Error("Staged release policy differs from the signing configuration.");
			}
		},
		postPackage: async (_config, result) => {
			for (const outputPath of result.outputPaths) {
				// Windows version resources must be edited on Electron's real PE
				// before it is renamed and the OS-only admission entrypoint is installed.
				if (windows) await installWindowsNativeAdmission(outputPath);
				if (!windows)
					finalizeLocalAppSignature(
						join(outputPath, "Quarterdeck.app"),
						releaseSettings.distributionMode !== "local",
					);
				await recordPackagedApp(outputPath, result.arch);
			}
		},
		postMake: async (_config, results) => recordMakeArtifacts(results),
	},
};
