import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { desktopResourcePathsForPlatform } from "../../desktop/scripts/desktop-resource-paths.mjs";
import { ensurePrivateDirectory } from "../../src/core/private-directory.js";
import * as appIdentity from "../../src/desktop-install/app-identity.js";
import { desktopFileSha256 } from "../../src/desktop-install/files.js";
import { createDesktopInstallationService } from "../../src/desktop-install/index.js";
import { desktopGlobalPackageSlot } from "../../src/desktop-install/layout.js";
import { desktopContainerName } from "../../src/desktop-install/metadata.js";
import type { DesktopInstallationDependencies } from "../../src/desktop-install/types.js";
import { acquireWindowsDesktopMutation } from "../../src/desktop-install/windows-admission.js";
import type { DesktopInstallationOwner } from "../../src/shared/desktop-installation-contract.js";
import { zipFixture } from "../utilities/zip-fixture.js";

const execute = promisify(execFile);
let root: string, native: string;
async function fixture(name: string, existingRoot?: string, legacy = false) {
	const directory = existingRoot ?? join(root, name);
	await ensurePrivateDirectory(directory);
	const source = join(directory, `source-${randomUUID()}`);
	const host = legacy ? source : join(source, "host");
	const resources = join(host, "resources");
	const identity = {
		schemaVersion: 1 as const,
		version: "0.12.16",
		buildId: randomUUID(),
		sourceSha: "a".repeat(40),
		sourceDirty: true,
	};
	const bundle = {
		...identity,
		schemaVersion: 1,
		platform: "win32",
		arch: process.arch,
		desktopLaunchProtocolVersion: 1,
		distributionMode: "local",
		signedDistribution: false,
		expectedTeamId: null,
		updateAuthority: "npm",
		channel: "stable",
		electronVersion: "44.10.2",
		nodeVersion: "22.22.2",
		nodeAbi: "127",
		runtimeLockSha256: "b".repeat(64),
		nodeArchive: { filename: "synthetic-node.zip", sha256: "c".repeat(64) },
	};
	const json: Record<string, unknown> = {
		"runtime/bundle-manifest.json": bundle,
		"runtime/dist/build-manifest.json": identity,
		"runtime/release-policy.json": {
			schemaVersion: 1,
			repository: "dankhole/quarterdeck",
			version: identity.version,
			arch: process.arch,
			buildId: identity.buildId,
			sourceSha: identity.sourceSha,
			distributionMode: "local",
			signedDistribution: false,
			expectedTeamId: null,
			updateAuthority: "npm",
			channel: "stable",
		},
		"desktop-shell.json": {
			name: "quarterdeck-desktop",
			bundleId: "io.github.dankhole.quarterdeck",
			version: identity.version,
			buildId: identity.buildId,
			sourceSha: identity.sourceSha,
		},
	};
	for (const path of desktopResourcePathsForPlatform("win32")) {
		const target = join(resources, path);
		await mkdir(dirname(target), { recursive: true });
		if (path.endsWith(".exe")) await copyFile(native, target);
		else await writeFile(target, path in json ? JSON.stringify(json[path]) : `synthetic-${identity.buildId}-${path}`);
	}
	for (const path of [
		join(source, "Quarterdeck.exe"),
		join(host, legacy ? "QuarterdeckHost.exe" : "Quarterdeck.exe"),
		join(resources, `runtime/node_modules/node-pty/prebuilds/win32-${process.arch}/conpty.node`),
		join(resources, `runtime/node_modules/node-pty/prebuilds/win32-${process.arch}/conpty_console_list.node`),
	]) {
		await mkdir(dirname(path), { recursive: true });
		await copyFile(native, path);
	}
	const prefix = join(directory, "prefix"),
		packageSlot = desktopGlobalPackageSlot(prefix);
	await mkdir(join(packageSlot, "dist"), { recursive: true });
	await writeFile(
		join(packageSlot, "package.json"),
		JSON.stringify({ name: "quarterdeck", version: identity.version }),
	);
	await writeFile(join(packageSlot, "dist/build-manifest.json"), JSON.stringify(identity));
	const owner: DesktopInstallationOwner = { kind: "npm", packageSlot, packageRoot: packageSlot, prefix, identity };
	const dependencies: DesktopInstallationDependencies = {
		platform: "win32",
		arch: process.arch,
		managedRoot: join(directory, "installation"),
		appPath: join(directory, "Programs/Quarterdeck"),
		owner,
		stageIdentity: { host: "synthetic-host", process: { pid: process.pid, creationIdentity: "synthetic-birth" } },
		acquireMutation: (_bootstrap, lock) => acquireWindowsDesktopMutation(native, lock),
		runCommand: async () => {
			throw new Error("Windows installation must not use macOS commands.");
		},
		download: async () => {
			throw new Error("Local installation must not download.");
		},
	};
	return {
		directory,
		source,
		resources,
		identity,
		owner,
		dependencies,
		service: createDesktopInstallationService(dependencies),
	};
}

describe.skipIf(process.platform !== "win32")("Windows desktop installation transactions", () => {
	beforeAll(async () => {
		await mkdir(resolve("desktop/.cache/test-results"), { recursive: true });
		root = await mkdtemp(join(resolve("desktop/.cache/test-results"), "windows-installation-"));
		await ensurePrivateDirectory(root);
		native = join(root, "admission.exe");
		await execute(
			process.execPath,
			[resolve("desktop/scripts/windows-native-admission.mjs"), "--output", native, "--test"],
			{ timeout: 120000, windowsHide: true },
		);
	}, 130000);
	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});
	it.each([false, true])(
		"verifies Windows release ZIP and resource provenance (corrupted=%s)",
		async (corrupted) => {
			const f = await fixture(`release-${corrupted}`);
			const { resources } = f;
			for (const path of [
				"runtime/bundle-manifest.json",
				"runtime/release-policy.json",
				"runtime/dist/build-manifest.json",
			]) {
				const file = join(resources, path),
					value = JSON.parse(await readFile(file, "utf8"));
				value.sourceDirty = false;
				if (path !== "runtime/dist/build-manifest.json") value.distributionMode = "windows-unsigned";
				await writeFile(file, JSON.stringify(value));
			}
			f.owner.identity = { ...f.identity, buildId: randomUUID(), sourceDirty: false };
			await writeFile(join(f.owner.packageRoot, "dist/build-manifest.json"), JSON.stringify(f.owner.identity));
			await writeFile(
				join(f.owner.packageRoot, "package.json"),
				JSON.stringify({
					name: "quarterdeck",
					version: f.identity.version,
					quarterdeck: { windowsDesktopRelease: "unsigned-v1" },
				}),
			);
			const entries: Array<{ name: string; data: Buffer }> = [];
			async function visit(directory: string): Promise<void> {
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) await visit(path);
					else entries.push({ name: relative(f.source, path).split(sep).join("/"), data: await readFile(path) });
				}
			}
			await visit(f.source);
			const archive = join(f.directory, "release.zip");
			await writeFile(archive, zipFixture(entries));
			const bundle = JSON.parse(await readFile(join(resources, "runtime/bundle-manifest.json"), "utf8"));
			const checksums = Object.fromEntries(
				await Promise.all(
					desktopResourcePathsForPlatform("win32").map(async (path) => [
						path,
						await desktopFileSha256(join(resources, path)),
					]),
				),
			);
			if (corrupted) checksums["app.asar"] = "f".repeat(64);
			const name = desktopContainerName(f.identity.version, process.arch as "x64" | "arm64", "win32");
			const manifest = {
				...bundle,
				distribution: "windows-unsigned",
				nativeAdmission: {
					schemaVersion: 1,
					bootstrapSha256: await desktopFileSha256(native),
					hostSha256: await desktopFileSha256(native),
				},
				checksums,
				fuses: {
					RunAsNode: false,
					EnableNodeOptionsEnvironmentVariable: false,
					EnableNodeCliInspectArguments: false,
					EnableCookieEncryption: true,
					EnableEmbeddedAsarIntegrityValidation: true,
					OnlyLoadAppFromAsar: true,
					GrantFileProtocolExtraPrivileges: false,
				},
				artifacts: [{ path: name, bytes: zipFixture(entries).length, sha256: await desktopFileSha256(archive) }],
			};
			f.dependencies.download = async (url, destination) => {
				if (url.endsWith(".json")) await writeFile(destination, JSON.stringify(manifest));
				else await copyFile(archive, destination);
			};
			const service = createDesktopInstallationService(f.dependencies);
			if (corrupted) {
				await expect(service.ensureDesktopInstallation({ version: f.identity.version })).rejects.toMatchObject({
					code: "invalid_artifact",
				});
				expect((await service.getDesktopInstallationStatus()).state).toBe("missing");
			} else {
				const installed = await service.ensureDesktopInstallation({ version: f.identity.version });
				expect(installed.source).toBe("release");
				expect(installed.buildId).not.toBe(f.owner.identity.buildId);
				expect((await service.validateDesktopInstallation()).installId).toBe(installed.installId);
				await service.uninstallDesktopInstallation();
			}
		},
		30000,
	);
	it("installs, validates and uninstalls an exact pair while preserving separate user state", async () => {
		const f = await fixture("ordinary");
		const userState = join(f.directory, "user-state.txt");
		await writeFile(userState, "preserve");
		const installed = await f.service.ensureDesktopInstallation({ version: f.identity.version, from: f.source });
		expect(installed.buildId).toBe(f.identity.buildId);
		expect(installed.cleanupPending).toBe(false);
		expect((await f.service.validateDesktopInstallation({ owner: f.owner })).installId).toBe(installed.installId);
		await writeFile(
			join(f.owner.packageRoot, "dist/build-manifest.json"),
			JSON.stringify({ ...f.identity, buildId: randomUUID() }),
		);
		await expect(f.service.validateDesktopInstallation()).rejects.toMatchObject({ code: "installation_changed" });
		await writeFile(join(f.owner.packageRoot, "dist/build-manifest.json"), JSON.stringify(f.identity));
		expect((await f.service.uninstallDesktopInstallation()).removed).toBe(true);
		expect(await readFile(userState, "utf8")).toBe("preserve");
		expect((await f.service.getDesktopInstallationStatus()).state).toBe("missing");
	}, 30000);
	it("reuses the verified Windows tree for launch and rehashes changed installations", async () => {
		const f = await fixture("launch-fingerprint");
		const installed = await f.service.ensureDesktopInstallation({ version: f.identity.version, from: f.source });
		const inspect = vi.spyOn(appIdentity, "inspectDesktopApp");
		try {
			// Windows shortcut publication can touch the launcher's metadata.
			const launcher = join(installed.appPath, "Quarterdeck.exe");
			const launcherInfo = await stat(launcher);
			await utimes(launcher, launcherInfo.atime, Date.now() / 1000);
			expect((await f.service.validateDesktopInstallationForLaunch()).installId).toBe(installed.installId);
			expect(inspect).not.toHaveBeenCalled();

			expect((await f.service.validateDesktopInstallation()).installId).toBe(installed.installId);
			expect(inspect).toHaveBeenCalledOnce();
			inspect.mockClear();

			const launcherBytes = await readFile(launcher);
			const alteredLauncher = Buffer.from(launcherBytes);
			alteredLauncher[alteredLauncher.length - 1] ^= 1;
			await writeFile(launcher, alteredLauncher);
			await expect(f.service.validateDesktopInstallationForLaunch()).rejects.toMatchObject({
				code: "invalid_artifact",
			});
			expect(inspect).toHaveBeenCalledOnce();
			await writeFile(launcher, launcherBytes);
			inspect.mockClear();

			const file = join(installed.appPath, "host/resources/runtime/dist/cli.js");
			const { atime, mtime, size } = await stat(file);
			await writeFile(file, Buffer.alloc(size, 0x78));
			await utimes(file, atime, mtime);
			await expect(f.service.validateDesktopInstallationForLaunch()).rejects.toMatchObject({
				code: "installation_changed",
			});
			expect(inspect).toHaveBeenCalledOnce();
		} finally {
			inspect.mockRestore();
		}
	}, 30000);
	it("rolls back a failed promotion and retains the previous exact pair", async () => {
		const first = await fixture("rollback", undefined, true);
		const installed = await first.service.ensureDesktopInstallation({
			version: first.identity.version,
			from: first.source,
		});
		const second = await fixture("unused", first.directory);
		second.dependencies.checkpoint = async (phase) => {
			if (phase === "promoted") throw new Error("synthetic promotion failure");
		};
		await expect(
			createDesktopInstallationService(second.dependencies).ensureDesktopInstallation({
				version: second.identity.version,
				from: second.source,
			}),
		).rejects.toThrow("synthetic promotion failure");
		await writeFile(join(first.owner.packageRoot, "dist/build-manifest.json"), JSON.stringify(first.identity));
		expect((await first.service.validateDesktopInstallation()).installId).toBe(installed.installId);
		await first.service.uninstallDesktopInstallation();
	}, 30000);
	it("retains a committed journal for cleanup and recovers it before uninstall", async () => {
		const f = await fixture("cleanup");
		f.dependencies.checkpoint = async (phase) => {
			if (phase === "receipt_committed") throw new Error("synthetic cleanup interruption");
		};
		const installed = await createDesktopInstallationService(f.dependencies).ensureDesktopInstallation({
			version: f.identity.version,
			from: f.source,
		});
		expect(installed.cleanupPending).toBe(true);
		expect((await f.service.getDesktopInstallationStatus()).pending).toBe(true);
		delete f.dependencies.checkpoint;
		expect((await createDesktopInstallationService(f.dependencies).uninstallDesktopInstallation()).removed).toBe(
			true,
		);
		expect((await f.service.getDesktopInstallationStatus()).state).toBe("missing");
	}, 30000);
	it("recovers shortcut publication without downloading or requiring the original --from option", async () => {
		const f = await fixture("presentation-recovery");
		let publications = 0;
		f.dependencies.presentation = {
			install: async () => {
				if (++publications === 1) throw new Error("synthetic shortcut failure");
			},
			uninstall: async () => {},
		};
		const service = createDesktopInstallationService(f.dependencies);
		expect(
			(await service.ensureDesktopInstallation({ version: f.identity.version, from: f.source })).cleanupPending,
		).toBe(true);
		const recovered = await service.ensureDesktopInstallation({ version: f.identity.version });
		expect(recovered.cleanupPending).toBe(false);
		expect((await service.getDesktopInstallationStatus()).pending).toBe(false);
		expect(publications).toBeGreaterThan(1);
		await service.uninstallDesktopInstallation();
	}, 30000);
});
