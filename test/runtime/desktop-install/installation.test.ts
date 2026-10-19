import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopAppTreeSha256 } from "../../../src/desktop-install/files.js";
import { createDesktopInstallationService } from "../../../src/desktop-install/index.js";
import { managedDesktopInstallationReceiptSchema } from "../../../src/desktop-install/receipt.js";
import { createDesktopAppFixture, createInstallerDependencies } from "./fixture.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-install-test-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

// Real installer admission requires POSIX ownership and private mode bits, absent on Windows.
describe.skipIf(process.platform === "win32")("one owned desktop installation", () => {
	it("imports into one stable path, preserves the source, and validates offline", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		expect(installed.appPath).toBe(dependencies.appPath);
		expect(installed.owner).toEqual(dependencies.owner);
		expect(await service.validateDesktopInstallation()).toEqual(installed);
		expect(await service.ensureDesktopInstallation({ version: "0.12.8" })).toEqual(installed);
		expect(await desktopAppTreeSha256(fixture.appPath)).toBe(await desktopAppTreeSha256(installed.appPath));
		expect(await readdir(dependencies.managedRoot)).toEqual(["managed-installation.json"]);
		expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
		expect(dependencies.download).not.toHaveBeenCalled();
	});
	it("replaces a same-version paired local build and removes its temporary backup", async () => {
		const first = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, first);
		const service = createDesktopInstallationService(dependencies);
		const a = await service.ensureDesktopInstallation({ version: "0.12.8", from: first.appPath });
		const next = await createDesktopAppFixture(root);
		dependencies.owner.identity.buildId = next.bundle.buildId;
		await writeFile(
			join(dependencies.owner.packageRoot, "dist/build-manifest.json"),
			JSON.stringify(dependencies.owner.identity),
		);
		const b = await service.ensureDesktopInstallation({ version: "0.12.8", from: next.appPath });
		expect(a.appPath).toBe(b.appPath);
		expect(a.installId).not.toBe(b.installId);
		expect(await readFile(join(b.appPath, "Contents/Resources/app.asar"), "utf8")).toBe(
			`shell-${next.bundle.buildId}`,
		);
		expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
	});
	it("refuses an unpaired same-version local build before copying", async () => {
		const first = await createDesktopAppFixture(root);
		const other = await createDesktopAppFixture(root);
		const { dependencies, commands } = await createInstallerDependencies(root, first);
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({
				version: "0.12.8",
				from: other.appPath,
			}),
		).rejects.toThrow("different source or local build");
		expect(commands.some((c) => c.command === "/usr/bin/ditto")).toBe(false);
	});
	it("downloads and verifies before in-use admission, preserving the installed pair on refusal", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const first = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const before = await readFile(first.receiptPath, "utf8");
		dependencies.acquireMutation = vi.fn(async () => {
			throw new Error("in use");
		});
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({
				version: "0.12.8",
				from: fixture.appPath,
			}),
		).rejects.toThrow("in use");
		expect(await readFile(first.receiptPath, "utf8")).toBe(before);
		expect(await service.validateDesktopInstallation()).toEqual(first);
		expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
	});
	it("requires explicit ownership transfer between npm slots", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const prefix = join(root, "other-prefix");
		const slot = join(prefix, "lib/node_modules/quarterdeck");
		await mkdir(join(prefix, "lib/node_modules"), { recursive: true });
		await symlink(dependencies.owner.packageRoot, slot);
		const owner = { ...dependencies.owner, prefix, packageSlot: slot };
		await expect(
			service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath, owner }),
		).rejects.toMatchObject({ code: "owner_conflict" });
		const moved = await service.ensureDesktopInstallation({
			version: "0.12.8",
			from: fixture.appPath,
			owner,
			replaceOwner: true,
		});
		expect(moved.owner.packageSlot).toBe(slot);
	});
	it("detects npm-first partial updates and missing linked checkouts without writing", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const before = await readFile(installed.receiptPath, "utf8");
		await writeFile(
			join(dependencies.owner.packageRoot, "dist/build-manifest.json"),
			JSON.stringify({ ...dependencies.owner.identity, buildId: randomUUID() }),
		);
		expect((await service.getDesktopInstallationStatus()).state).toBe("changed");
		await expect(service.validateDesktopInstallation()).rejects.toThrow("owning npm CLI");
		expect(await readFile(installed.receiptPath, "utf8")).toBe(before);
		await rm(dependencies.owner.packageSlot);
		await expect(service.validateDesktopInstallation()).rejects.toThrow("owning npm CLI");
	});
	it("repairs an externally removed managed app using its recorded owner", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		await rm(installed.appPath, { recursive: true });
		expect((await service.getDesktopInstallationStatus()).state).toBe("changed");
		const repaired = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		expect(repaired.installId).not.toBe(installed.installId);
		expect((await service.getDesktopInstallationStatus()).state).toBe("ready");
	});
	it("rejects metadata and Applications ancestors redirected by a user symbolic link", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const outside = join(root, "outside");
		await mkdir(outside);
		const alias = join(root, "alias");
		await symlink(outside, alias);
		for (const changes of [
			{ managedRoot: join(alias, "installation") },
			{ appPath: join(alias, "Applications/Quarterdeck.app") },
		]) {
			await expect(
				createDesktopInstallationService({ ...dependencies, ...changes }).ensureDesktopInstallation({
					version: "0.12.8",
					from: fixture.appPath,
				}),
			).rejects.toThrow("path ancestor");
		}
		expect(await readdir(outside)).toEqual([]);
		expect(dependencies.acquireMutation).not.toHaveBeenCalled();
	});
	it("retains changed and unmanaged apps instead of replacing them", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const first = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const file = join(first.appPath, "Contents/Resources/app.asar");
		await writeFile(file, "external mutation");
		await expect(service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath })).rejects.toThrow(
			"current app changed",
		);
		expect(await readFile(file, "utf8")).toBe("external mutation");
		await rm(first.receiptPath);
		await expect(service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath })).rejects.toThrow(
			"unmanaged app",
		);
	});
	it("restores an interrupted pre-promotion backup before retrying", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const first = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const receipt = managedDesktopInstallationReceiptSchema.parse(
			JSON.parse(await readFile(first.receiptPath, "utf8")),
		);
		const id = randomUUID();
		const stage = join(root, "Applications", `.Quarterdeck-install-${id}`);
		await mkdir(stage, { mode: 0o700 });
		await rename(first.appPath, join(stage, "backup.app"));
		await writeFile(
			join(dependencies.managedRoot, "transaction.json"),
			JSON.stringify({
				schemaVersion: 1,
				id,
				stage,
				oldReceipt: receipt,
				newReceipt: { ...receipt, installId: randomUUID() },
			}),
		);
		expect((await service.getDesktopInstallationStatus()).state).toBe("incomplete");
		const next = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		expect(await service.validateDesktopInstallation()).toEqual(next);
		expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
	});
	it("adopts an exact promoted app after interruption before receipt publication", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const first = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const receipt = managedDesktopInstallationReceiptSchema.parse(
			JSON.parse(await readFile(first.receiptPath, "utf8")),
		);
		const id = randomUUID();
		const stage = join(root, "Applications", `.Quarterdeck-install-${id}`);
		await mkdir(stage, { mode: 0o700 });
		await cp(first.appPath, join(stage, "backup.app"), { recursive: true });
		await rm(first.receiptPath);
		await writeFile(
			join(dependencies.managedRoot, "transaction.json"),
			JSON.stringify({ schemaVersion: 1, id, stage, oldReceipt: receipt, newReceipt: receipt }),
		);
		await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		expect((await service.getDesktopInstallationStatus()).state).toBe("ready");
	});
	it("uninstalls only its verified app while preserving user state and the coordination sentinel", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		await writeFile(join(root, "settings.json"), "user settings");
		await writeFile(join(dependencies.managedRoot, "admission.lock"), "");
		expect((await service.uninstallDesktopInstallation()).removed).toBe(true);
		expect(await readFile(join(root, "settings.json"), "utf8")).toBe("user settings");
		expect(await readdir(dependencies.managedRoot)).toEqual(["admission.lock"]);
		expect((await service.getDesktopInstallationStatus()).state).toBe("missing");
	});
	it("rejects external links and unsafe app metadata before mutation", async () => {
		const fixture = await createDesktopAppFixture(root);
		await symlink(root, join(fixture.appPath, "escape"));
		const { dependencies } = await createInstallerDependencies(root, fixture);
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({
				version: "0.12.8",
				from: fixture.appPath,
			}),
		).rejects.toThrow("external or invalid symbolic link");
		expect(dependencies.acquireMutation).not.toHaveBeenCalled();
	});
});

describe("desktop installation input policy", () => {
	it("rejects unsupported hosts, unsafe versions, and translated Intel Node", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		await expect(
			createDesktopInstallationService({ ...dependencies, platform: "linux" }).ensureDesktopInstallation({
				version: "0.12.8",
			}),
		).rejects.toThrow("native macOS");
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({ version: "../latest" }),
		).rejects.toThrow("exact npm version");
		dependencies.runCommand = vi.fn(async () => ({ stdout: "1", stderr: "" }));
		await expect(
			createDesktopInstallationService({ ...dependencies, arch: "x64" }).ensureDesktopInstallation({
				version: "0.12.8",
			}),
		).rejects.toThrow("native arm64 Node");
	});
});
