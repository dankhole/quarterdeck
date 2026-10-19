import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDesktopInstallationService } from "../../../src/desktop-install/index.js";
import type { DesktopInstallationDependencies } from "../../../src/desktop-install/types.js";
import { createDesktopAppFixture, createInstallerDependencies } from "./fixture.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-recovery-test-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
async function changeOwnerBuild(dependencies: DesktopInstallationDependencies, buildId: string) {
	if (!dependencies.owner) throw new Error("fixture owner missing");
	dependencies.owner.identity = { ...dependencies.owner.identity, buildId };
	await writeFile(
		join(dependencies.owner.packageRoot, "dist/build-manifest.json"),
		JSON.stringify(dependencies.owner.identity),
	);
}
// Recovery crosses real installer admission, including POSIX ownership and private mode bits.
describe.skipIf(process.platform === "win32")("transaction failures and resumable cleanup", () => {
	it.each(["backed_up", "promoted", "metadata_written"] as const)(
		"rolls back a live %s failure without leaving a partial canonical app",
		async (failure) => {
			const first = await createDesktopAppFixture(root, { signed: true });
			const { dependencies } = await createInstallerDependencies(root, first);
			const installed = await createDesktopInstallationService(dependencies).ensureDesktopInstallation({
				version: "0.12.8",
			});
			const oldReceipt = await readFile(installed.receiptPath, "utf8");
			const oldManifest = await readFile(join(dependencies.managedRoot, "release-manifest.json"), "utf8");
			const next = await createDesktopAppFixture(root);
			await changeOwnerBuild(dependencies, next.bundle.buildId);
			let injected = false;
			const faulted: DesktopInstallationDependencies = {
				...dependencies,
				checkpoint: async (phase) => {
					if (phase === failure && !injected) {
						injected = true;
						throw new Error("injected I/O failure");
					}
				},
			};
			await expect(
				createDesktopInstallationService(faulted).ensureDesktopInstallation({
					version: "0.12.8",
					from: next.appPath,
				}),
			).rejects.toThrow("injected I/O failure");
			expect(await readFile(installed.receiptPath, "utf8")).toBe(oldReceipt);
			expect(await readFile(join(installed.appPath, "Contents/Resources/app.asar"), "utf8")).toBe(
				`shell-${first.bundle.buildId}`,
			);
			expect(await readFile(join(dependencies.managedRoot, "release-manifest.json"), "utf8")).toBe(oldManifest);
			expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
			// npm has already advanced; preserving the app cannot roll npm back. Pairing stays closed until npm is repaired.
			expect((await createDesktopInstallationService(dependencies).getDesktopInstallationStatus()).state).toBe(
				"changed",
			);
			await changeOwnerBuild(dependencies, first.bundle.buildId);
			expect((await createDesktopInstallationService(dependencies).getDesktopInstallationStatus()).state).toBe(
				"ready",
			);
		},
	);
	it("returns committed success and resumes a partially deleted old backup on the next install", async () => {
		const first = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, first);
		await createDesktopInstallationService(dependencies).ensureDesktopInstallation({
			version: "0.12.8",
			from: first.appPath,
		});
		const next = await createDesktopAppFixture(root);
		await changeOwnerBuild(dependencies, next.bundle.buildId);
		let injected = false;
		const faulted: DesktopInstallationDependencies = {
			...dependencies,
			checkpoint: async (phase) => {
				if (phase !== "cleanup_authorized" || injected) return;
				injected = true;
				const journal = JSON.parse(await readFile(join(dependencies.managedRoot, "transaction.json"), "utf8")) as {
					stage: string;
					cleanupBackup: { dev: number; ino: number };
				};
				expect(journal.cleanupBackup).toBeTruthy();
				await rm(join(journal.stage, "backup.app/Contents/Resources/app.asar"));
				throw new Error("cleanup interrupted");
			},
		};
		const service = createDesktopInstallationService(faulted);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: next.appPath });
		expect(installed.cleanupPending).toBe(true);
		expect((await service.getDesktopInstallationStatus()).pending).toBe(true);
		const repaired = await service.ensureDesktopInstallation({ version: "0.12.8", from: next.appPath });
		expect(repaired.cleanupPending).toBe(false);
		expect((await service.getDesktopInstallationStatus()).state).toBe("ready");
		expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
	});
	it("finishes committed uninstall cleanup with its journal-scoped helper when the app and receipt are gone", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		await createDesktopInstallationService(dependencies).ensureDesktopInstallation({
			version: "0.12.8",
			from: fixture.appPath,
		});
		let injected = false;
		const faulted: DesktopInstallationDependencies = {
			...dependencies,
			checkpoint: async (phase) => {
				if (phase !== "cleanup_authorized" || injected) return;
				injected = true;
				const journal = JSON.parse(await readFile(join(dependencies.managedRoot, "transaction.json"), "utf8")) as {
					stage: string;
					bootstrap: { sha256: string };
				};
				expect(journal.bootstrap.sha256).toHaveLength(64);
				expect((await lstat(join(journal.stage, "mutation-bootstrap"))).isFile()).toBe(true);
				await rm(join(journal.stage, "backup.app/Contents/Resources/app.asar"));
				throw new Error("cleanup interrupted");
			},
		};
		const service = createDesktopInstallationService(faulted);
		expect(await service.uninstallDesktopInstallation()).toMatchObject({ removed: true, cleanupPending: true });
		expect((await service.getDesktopInstallationStatus()).state).toBe("incomplete");
		expect((await service.uninstallDesktopInstallation()).removed).toBe(false);
		expect((await service.getDesktopInstallationStatus()).state).toBe("missing");
		expect(await readdir(join(root, "Applications"))).toEqual([]);
		expect(await readdir(dependencies.managedRoot)).toEqual([]);
	});
	it("retains a substituted backup directory instead of authorizing deletion from an old inode marker", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		await createDesktopInstallationService(dependencies).ensureDesktopInstallation({
			version: "0.12.8",
			from: fixture.appPath,
		});
		let injected = false;
		const faulted: DesktopInstallationDependencies = {
			...dependencies,
			checkpoint: async (phase) => {
				if (phase === "cleanup_authorized" && !injected) {
					injected = true;
					throw new Error("stop cleanup");
				}
			},
		};
		const service = createDesktopInstallationService(faulted);
		expect(await service.uninstallDesktopInstallation()).toMatchObject({ cleanupPending: true });
		const journal = JSON.parse(await readFile(join(dependencies.managedRoot, "transaction.json"), "utf8")) as {
			cleanupBackup: { dev: number; ino: number };
		};
		journal.cleanupBackup.ino += 100000;
		await writeFile(join(dependencies.managedRoot, "transaction.json"), JSON.stringify(journal));
		await expect(service.uninstallDesktopInstallation()).rejects.toThrow("changed during cleanup");
		expect((await service.getDesktopInstallationStatus()).state).toBe("incomplete");
	});
	it("refuses forged journal paths without touching an unrelated directory", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		await createDesktopInstallationService(dependencies).ensureDesktopInstallation({
			version: "0.12.8",
			from: fixture.appPath,
		});
		await writeFile(
			join(dependencies.managedRoot, "transaction.json"),
			JSON.stringify({ schemaVersion: 1, id: randomUUID(), stage: root, oldReceipt: null, newReceipt: null }),
		);
		await expect(createDesktopInstallationService(dependencies).uninstallDesktopInstallation()).rejects.toThrow(
			"journal cannot be verified",
		);
		expect((await lstat(fixture.appPath)).isDirectory()).toBe(true);
	});
	it("retains recovery candidates when the expected release manifest is absent", async () => {
		const fixture = await createDesktopAppFixture(root, { signed: true });
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8" });
		const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8")) as unknown;
		const id = randomUUID();
		const stage = join(root, "Applications", `.Quarterdeck-install-${id}`);
		await mkdir(stage, { mode: 0o700 });
		await writeFile(
			join(dependencies.managedRoot, "transaction.json"),
			JSON.stringify({ schemaVersion: 1, id, stage, oldReceipt: null, newReceipt: receipt }),
		);
		await rm(join(dependencies.managedRoot, "release-manifest.json"));
		await expect(service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath })).rejects.toThrow();
		expect((await lstat(join(dependencies.managedRoot, "transaction.json"))).isFile()).toBe(true);
		expect((await lstat(installed.appPath)).isDirectory()).toBe(true);
	});
	it("publishes a release manifest without following an existing destination symbolic link", async () => {
		const fixture = await createDesktopAppFixture(root, { signed: true });
		const { dependencies } = await createInstallerDependencies(root, fixture);
		await mkdir(dependencies.managedRoot, { mode: 0o700 });
		const outside = join(root, "external.txt");
		await writeFile(outside, "preserve external file");
		await symlink(outside, join(dependencies.managedRoot, "release-manifest.json"));
		await createDesktopInstallationService(dependencies).ensureDesktopInstallation({ version: "0.12.8" });
		expect(await readFile(outside, "utf8")).toBe("preserve external file");
		expect((await lstat(join(dependencies.managedRoot, "release-manifest.json"))).isSymbolicLink()).toBe(false);
	});
	it("refuses a pending stage replaced by a symbolic link before reading or deleting descendants", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8")) as unknown;
		const id = randomUUID();
		const stage = join(root, "Applications", `.Quarterdeck-install-${id}`);
		const outside = join(root, "moved-stage");
		await mkdir(outside, { mode: 0o700 });
		await rename(installed.appPath, join(outside, "backup.app"));
		await symlink(outside, stage);
		await writeFile(
			join(dependencies.managedRoot, "transaction.json"),
			JSON.stringify({ schemaVersion: 1, id, stage, oldReceipt: receipt, newReceipt: receipt }),
		);
		await expect(service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath })).rejects.toThrow(
			"symbolic link",
		);
		expect((await lstat(join(outside, "backup.app"))).isDirectory()).toBe(true);
	});
});
