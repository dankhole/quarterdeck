import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildWindowsAdmission } from "../../desktop/scripts/windows-native-admission.mjs";
import { ensurePrivateDirectory } from "../../src/core/private-directory.js";
import { copyDesktopTreePrivate } from "../../src/desktop-install/files.js";
import { createDesktopInstallationService } from "../../src/desktop-install/index.js";
import { desktopBootstrapPath, desktopGlobalPackageSlot } from "../../src/desktop-install/layout.js";
import type { DesktopInstallation, DesktopInstallationDependencies } from "../../src/desktop-install/types.js";
import { acquireWindowsDesktopMutation } from "../../src/desktop-install/windows-admission.js";
import { updateWindowsDesktopShortcut } from "../../src/desktop-install/windows-shortcut.js";
import { desktopBuildIdentitySchema } from "../../src/shared/desktop-installation-contract.js";
import type { DesktopLabFixture } from "./desktop-fixture";
import { writeJsonAtomic } from "./paths";

const execute = promisify(execFile);

export interface WindowsDesktopLabInstallation {
	service: ReturnType<typeof createDesktopInstallationService>;
	sourceApp: string;
	metadataRoot: string;
	version: string;
	initial: DesktopInstallation;
}

/** Compile-time redirection exists only in this isolated copy; no production
 * environment variable can redirect native installation admission or shortcuts. */
export async function prepareWindowsDesktopLabApp(source: string, tempRoot: string) {
	await ensurePrivateDirectory(tempRoot);
	const profile = join(tempRoot, "native-profile");
	await mkdir(profile);
	const sourceApp = join(tempRoot, "source-app");
	await copyDesktopTreePrivate(source, sourceApp);
	const appPath = join(profile, "AppData/Local/Programs/Quarterdeck");
	const metadataRoot = join(profile, "AppData/Local/Quarterdeck/installation");
	await ensurePrivateDirectory(metadataRoot);
	await mkdir(join(profile, "StartMenu"));
	const bootstrap = join(tempRoot, "native-build/admission.exe");
	await buildWindowsAdmission(bootstrap, { gui: true, labProfileRoot: profile });
	for (const entry of [
		"Quarterdeck.exe",
		"host/resources/runtime/bin/node.exe",
		"host/resources/runtime/installation-admission.exe",
	])
		await copyFile(bootstrap, join(sourceApp, entry));
	const identity = desktopBuildIdentitySchema.parse(
		JSON.parse(await readFile(join(sourceApp, "host/resources/runtime/dist/build-manifest.json"), "utf8")),
	);
	const prefix = join(tempRoot, "npm-prefix"),
		packageSlot = desktopGlobalPackageSlot(prefix);
	await mkdir(join(packageSlot, "dist"), { recursive: true });
	await writeFile(
		join(packageSlot, "package.json"),
		JSON.stringify({ name: "quarterdeck", version: identity.version }),
	);
	await writeFile(join(packageSlot, "dist/build-manifest.json"), JSON.stringify(identity));
	const dependencies: DesktopInstallationDependencies = {
		platform: "win32",
		arch: process.arch,
		managedRoot: metadataRoot,
		appPath,
		owner: { kind: "npm", prefix, packageSlot, packageRoot: packageSlot, identity },
		presentation: {
			install: (path) => updateWindowsDesktopShortcut(desktopBootstrapPath(path, "win32"), "install"),
			uninstall: (path) => updateWindowsDesktopShortcut(path, "remove"),
		},
		runCommand: async () => {
			throw new Error("Windows installation must not invoke macOS tools.");
		},
		download: async () => {
			throw new Error("This packaged lab imports its exact local candidate.");
		},
	};
	const service = createDesktopInstallationService(dependencies);
	const initial = await service.ensureDesktopInstallation({ version: identity.version, from: sourceApp });
	return {
		appPath,
		executablePath: join(appPath, "Quarterdeck.exe"),
		installation: { service, sourceApp, metadataRoot, version: identity.version, initial },
	};
}

export async function assertWindowsDesktopInUse(fixture: DesktopLabFixture): Promise<void> {
	const installation = fixture.windowsInstallation;
	if (!installation) throw new Error("Missing isolated Windows installation.");
	await execute(fixture.manifest.executablePath, ["--quarterdeck-test-check-shortcut"], {
		windowsHide: true,
		timeout: 5_000,
	});
	try {
		const release = await acquireWindowsDesktopMutation(
			desktopBootstrapPath(installation.sourceApp, "win32"),
			join(installation.metadataRoot, "admission.lock"),
		);
		await release();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "installation_in_use") return;
		throw error;
	}
	throw new Error("Packaged Windows application did not block installation mutation.");
}

export async function finishWindowsDesktopLifecycle(fixture: DesktopLabFixture): Promise<void> {
	const installation = fixture.windowsInstallation;
	if (!installation || fixture.manifest.remainingPids.length || fixture.manifest.shutdown?.fallbackUsed)
		throw new Error("Windows lifecycle requires confirmed graceful process cleanup.");
	const before = await installation.service.validateDesktopInstallation();
	const replaced = await installation.service.ensureDesktopInstallation({
		version: installation.version,
		from: installation.sourceApp,
	});
	if (replaced.installId === before.installId || replaced.cleanupPending)
		throw new Error("Windows packaged replacement did not complete.");
	await installation.service.uninstallDesktopInstallation();
	if ((await installation.service.getDesktopInstallationStatus()).state !== "missing")
		throw new Error("Windows packaged uninstall remained incomplete.");
	await readFile(fixture.configPath); // independent user/runtime state must survive app removal
	await writeJsonAtomic(join(fixture.manifest.artifactDir, "windows-installation-lifecycle.json"), {
		installed: true,
		mutationBlockedWhileRunning: true,
		gracefulQuit: true,
		replaced: true,
		uninstalled: true,
		userStatePreserved: true,
		remainingPids: fixture.manifest.remainingPids,
	});
}

import { execFile } from "node:child_process";
