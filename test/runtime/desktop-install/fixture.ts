import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { desktopFileSha256 } from "../../../src/desktop-install/files.js";
import { desktopContainerName, desktopResourcePaths } from "../../../src/desktop-install/metadata.js";
import { desktopApplicationBundleId } from "../../../src/desktop-install/receipt.js";
import type { DesktopInstallationDependencies } from "../../../src/desktop-install/types.js";

export async function createDesktopAppFixture(
	root: string,
	options: { signed?: boolean; version?: string; arch?: "arm64" | "x64"; launchProtocol?: boolean } = {},
) {
	const version = options.version ?? "0.12.8";
	const arch = options.arch ?? "arm64";
	const appPath = join(root, `Quarterdeck ${randomUUID()} Ω.app`);
	const resources = join(appPath, "Contents/Resources");
	const bundle = {
		schemaVersion: 1,
		platform: "darwin",
		arch,
		version,
		buildId: randomUUID(),
		sourceSha: "a".repeat(40),
		sourceDirty: false,
		...(options.launchProtocol === false ? {} : { desktopLaunchProtocolVersion: 1 }),
		signedDistribution: options.signed ?? false,
		expectedTeamId: options.signed ? "ABCDE12345" : null,
		productionUpdatesEnabled: (options.signed ?? false) && !version.includes("-"),
		channel: version.includes("-") ? "preview" : "stable",
		validationFeedBase: null,
		electronVersion: "44.5.1",
		nodeVersion: "22.22.2",
		nodeAbi: "127",
		minimumMacOSVersion: "13.0",
		runtimeLockSha256: "b".repeat(64),
		nodeArchive: { filename: `node-v22.22.2-darwin-${arch}.tar.gz`, sha256: "c".repeat(64) },
	};
	const policy = {
		schemaVersion: 1,
		repository: "dankhole/quarterdeck",
		version,
		arch,
		buildId: bundle.buildId,
		sourceSha: bundle.sourceSha,
		signedDistribution: bundle.signedDistribution,
		expectedTeamId: bundle.expectedTeamId,
		productionUpdatesEnabled: bundle.productionUpdatesEnabled,
		channel: bundle.channel,
		validationFeedBase: null,
	};
	const files: Record<string, string> = {
		"Contents/Info.plist": JSON.stringify({
			CFBundleIdentifier: desktopApplicationBundleId,
			CFBundleShortVersionString: version,
			CFBundleExecutable: "Quarterdeck",
		}),
		"Contents/MacOS/Quarterdeck": arch,
		"Contents/Resources/app.asar": `shell-${bundle.buildId}`,
		"Contents/Resources/runtime/bin/node": arch,
		"Contents/Resources/runtime/node_modules/node-pty/build/Release/pty.node": arch,
		"Contents/Resources/runtime/dist/cli.js": `runtime-${bundle.buildId}`,
		"Contents/Resources/runtime/dist/web-ui/index.html": `<main>${bundle.buildId}</main>`,
		"Contents/Resources/runtime/bundle-manifest.json": JSON.stringify(bundle),
		"Contents/Resources/runtime/release-policy.json": JSON.stringify(policy),
	};
	for (const [name, content] of Object.entries(files)) {
		const path = join(appPath, name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	}
	for (const name of ["Contents/MacOS/Quarterdeck", "Contents/Resources/runtime/bin/node"])
		await chmod(join(appPath, name), 0o755);
	const checksums = Object.fromEntries(
		await Promise.all(
			desktopResourcePaths.map(async (name) => [name, await desktopFileSha256(join(resources, name))]),
		),
	);
	const containerBytes = Buffer.from("synthetic matching disk image");
	const containerPath = join(root, `${randomUUID()}.dmg`);
	await writeFile(containerPath, containerBytes);
	const manifest = {
		...bundle,
		distribution: "signed-notarized",
		fuses: {
			RunAsNode: false,
			EnableNodeOptionsEnvironmentVariable: false,
			EnableNodeCliInspectArguments: false,
			EnableCookieEncryption: true,
			EnableEmbeddedAsarIntegrityValidation: true,
			OnlyLoadAppFromAsar: true,
			GrantFileProtocolExtraPrivileges: false,
		},
		checksums,
		artifacts: [
			{
				path: desktopContainerName(version, arch),
				bytes: containerBytes.length,
				sha256: await desktopFileSha256(containerPath),
			},
		],
	};
	return { appPath, bundle, manifest, containerBytes };
}

export function createInstallerDependencies(
	root: string,
	fixture?: Awaited<ReturnType<typeof createDesktopAppFixture>>,
) {
	const commands: Array<{ command: string; args: readonly string[] }> = [];
	const runCommand: DesktopInstallationDependencies["runCommand"] = vi.fn(async (command, args) => {
		commands.push({ command, args });
		if (command === "/usr/bin/plutil") return { stdout: await readFile(args[args.length - 1], "utf8"), stderr: "" };
		if (command === "/usr/bin/lipo")
			return { stdout: (await readFile(args[1], "utf8")) === "x64" ? "x86_64\n" : "arm64\n", stderr: "" };
		if (command === "/usr/bin/ditto") {
			await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
			return { stdout: "", stderr: "" };
		}
		if (command === "/usr/bin/hdiutil" && args[0] === "attach" && fixture) {
			const mount = args[args.indexOf("-mountpoint") + 1];
			await cp(fixture.appPath, join(mount, "Quarterdeck.app"), { recursive: true, verbatimSymlinks: true });
			return { stdout: "<plist/>", stderr: "" };
		}
		if (command === "/usr/bin/codesign" && args[0] === "--display")
			return {
				stdout: "",
				stderr:
					"Authority=Developer ID Application: Quarterdeck (ABCDE12345)\nTeamIdentifier=ABCDE12345\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=1\n",
			};
		return { stdout: "", stderr: "" };
	});
	const download: DesktopInstallationDependencies["download"] = vi.fn(async (url, destination) => {
		if (!fixture) throw new Error("Unexpected download in local import.");
		await writeFile(destination, url.endsWith(".json") ? JSON.stringify(fixture.manifest) : fixture.containerBytes);
	});
	return {
		dependencies: {
			platform: "darwin" as const,
			arch: "arm64",
			managedRoot: join(root, "managed"),
			runCommand,
			download,
		},
		commands,
	};
}
