import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { recordMakeArtifacts, recordPackagedApp } from "./scripts/artifact-manifest.mjs";
import { MakerDMG } from "./scripts/maker-dmg.mjs";
import { desktopRoot, requireNativeMacTarget, resolveTargetArch, stagedRuntimePath } from "./scripts/paths.mjs";
import { releaseBuildSettings } from "./scripts/release-policy.mjs";
import { copyRuntimeResource } from "./scripts/runtime-resources.mjs";
import { signingOptionsForFile } from "./scripts/signing-entitlements.mjs";

const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
const arch = resolveTargetArch(process.env.QUARTERDECK_DESKTOP_ARCH);
const runtimePath = stagedRuntimePath(arch);

// M1 artifacts are unsigned. Later protected CI can opt into signing using an
// existing temporary keychain and a notarytool keychain profile. No publisher is
// configured; signed DMG notarization/stapling remains a separate release gate.
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
		icon: join(desktopRoot, "assets", "quarterdeck.icns"),
		asar: true,
		afterCopy: [async ({ buildPath }) => copyRuntimeResource(runtimePath, buildPath)],
		ignore: [/^\/(?!dist(?:\/|$)|package\.json$)/u],
		download: { cacheRoot: join(desktopRoot, ".cache", "electron") },
		extendInfo: { LSMinimumSystemVersion: desktopPackage.quarterdeckDesktop.minimumMacOSVersion },
		...(signing
			? {
					osxSign: {
						identity: requiredEnvironment("QUARTERDECK_DESKTOP_SIGNING_IDENTITY"),
						keychain: requiredEnvironment("QUARTERDECK_DESKTOP_SIGNING_KEYCHAIN"),
						// Never inherit osx-sign's broad default device/plugin grants.
						preAutoEntitlements: false,
						preEmbedProvisioningProfile: false,
						optionsForFile: signingOptionsForFile,
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
			resetAdHocDarwinSignature: true,
			strictlyRequireAllFuses: true,
			[FuseV1Options.RunAsNode]: false,
			[FuseV1Options.EnableCookieEncryption]: true,
			[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
			// The isolated unsigned Agent Lab uses Playwright's inspector transport.
			[FuseV1Options.EnableNodeCliInspectArguments]: !signing,
			[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
			[FuseV1Options.OnlyLoadAppFromAsar]: true,
			[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
			[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
			[FuseV1Options.WasmTrapHandlers]: true,
		}),
	],
	makers: [
		new MakerDMG({ name: `Quarterdeck-${desktopPackage.version}-${arch}` }),
		{ name: "@electron-forge/maker-zip", platforms: ["darwin"], config: {} },
	],
	publishers: [],
	hooks: {
		prePackage: async (_config, platform, targetArch) => {
			requireNativeMacTarget(targetArch);
			if (platform !== "darwin" || targetArch !== arch)
				throw new Error(
					"Forge target differs from the staged native runtime. Use the desktop npm packaging commands.",
				);
			const manifest = JSON.parse(await readFile(join(runtimePath, "bundle-manifest.json"), "utf8"));
			if (manifest.arch !== arch || manifest.version !== desktopPackage.version)
				throw new Error("Staged runtime is stale. Use the desktop npm packaging commands.");
			for (const [key, value] of Object.entries(releaseSettings)) {
				if (manifest[key] !== value)
					throw new Error("Staged release policy differs from the signing configuration.");
			}
		},
		postPackage: async (_config, result) => {
			for (const outputPath of result.outputPaths) await recordPackagedApp(outputPath, result.arch);
		},
		postMake: async (_config, results) => recordMakeArtifacts(results),
	},
};
