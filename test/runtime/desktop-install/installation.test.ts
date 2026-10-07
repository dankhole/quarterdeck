import { chmod, lstat, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopInstallationService } from "../../../src/desktop-install/index.js";
import { managedDesktopInstallationReceiptSchema } from "../../../src/desktop-install/receipt.js";
import { createDesktopAppFixture, createInstallerDependencies } from "./fixture.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-install-test-"));
});
afterEach(async () => {
	// Owned synthetic trees only; installed copies intentionally retain read-only directories.
	async function writable(path: string): Promise<void> {
		const info = await lstat(path);
		if (info.isSymbolicLink()) return;
		await chmod(path, info.mode | 0o700);
		if (info.isDirectory()) for (const child of await readdir(path)) await writable(join(path, child));
	}
	await writable(root);
	await rm(root, { recursive: true, force: true });
});

describe("managed desktop installation", () => {
	it("imports a local app, preserves its source, and revalidates it offline before reuse", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies, commands } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		expect(installed).toMatchObject({
			version: "0.12.8",
			arch: "arm64",
			source: "local",
			buildId: fixture.bundle.buildId,
		});
		expect(installed.appPath).toBe(
			await realpath(join(dependencies.managedRoot, "installations", installed.installId, "Quarterdeck.app")),
		);
		const receipt = managedDesktopInstallationReceiptSchema.parse(
			JSON.parse(await readFile(installed.receiptPath, "utf8")),
		);
		expect(receipt).toMatchObject({
			updatesEnabled: false,
			signing: { verified: false, teamId: null },
			release: null,
		});
		expect((await lstat(join(installed.appPath, "Contents/Resources/app.asar"))).mode & 0o222).toBe(0);
		expect((await lstat(fixture.appPath)).mode & 0o200).not.toBe(0);
		expect(await service.ensureDesktopInstallation({ version: "0.12.8" })).toEqual(installed);
		expect(dependencies.download).not.toHaveBeenCalled();
		expect(commands.some((call) => call.command.includes("codesign"))).toBe(false);
		expect(await readdir(dependencies.managedRoot)).toEqual(["installations", "selections"]);
	});

	it("selects a new same-version local build without mutating the old installation", async () => {
		const first = await createDesktopAppFixture(root);
		const second = await createDesktopAppFixture(root);
		const { dependencies } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		const a = await service.ensureDesktopInstallation({ version: "0.12.8", from: first.appPath });
		const b = await service.ensureDesktopInstallation({ version: "0.12.8", from: second.appPath });
		expect(b.installId).not.toBe(a.installId);
		expect(b.appAsarSha256).not.toBe(a.appAsarSha256);
		expect(await service.ensureDesktopInstallation({ version: "0.12.8" })).toEqual(b);
		expect(await readFile(join(a.appPath, "Contents/Resources/app.asar"), "utf8")).toBe(
			`shell-${first.bundle.buildId}`,
		);
		expect(await readdir(join(dependencies.managedRoot, "installations"))).toHaveLength(2);
	});

	it("leaves the prior selection and all apps intact when copying a replacement fails", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const original = dependencies.runCommand;
		dependencies.runCommand = vi.fn(async (command, args) => {
			if (command === "/usr/bin/ditto") throw new Error("copy denied");
			return original(command, args);
		});
		await expect(service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath })).rejects.toThrow(
			"copy denied",
		);
		expect(await service.ensureDesktopInstallation({ version: "0.12.8" })).toEqual(installed);
		expect(await readdir(dependencies.managedRoot)).toEqual(["installations", "selections"]);
	});

	it("allows concurrent complete imports and publishes a pointer to a validated winner", async () => {
		const a = await createDesktopAppFixture(root);
		const b = await createDesktopAppFixture(root);
		const { dependencies } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		const results = await Promise.all([
			service.ensureDesktopInstallation({ version: "0.12.8", from: a.appPath }),
			service.ensureDesktopInstallation({ version: "0.12.8", from: b.appPath }),
		]);
		const selected = await service.ensureDesktopInstallation({ version: "0.12.8" });
		expect(results).toContainEqual(selected);
		expect(await readdir(join(dependencies.managedRoot, "installations"))).toHaveLength(2);
		expect(await readdir(dependencies.managedRoot)).toEqual(["installations", "selections"]);
	});

	it("refuses a changed selected app instead of executing, replacing, or downloading around it", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const file = join(installed.appPath, "Contents/Resources/app.asar");
		await chmod(file, 0o600);
		await writeFile(file, "mutated by updater");
		await expect(service.ensureDesktopInstallation({ version: "0.12.8" })).rejects.toThrow(
			"changed after installation",
		);
		expect(dependencies.download).not.toHaveBeenCalled();
		expect(await readFile(file, "utf8")).toBe("mutated by updater");
	});

	it("rejects a forged pointer path and retains its bytes", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const pointer = join(dependencies.managedRoot, "selections/0.12.8-darwin-arm64.json");
		const content = JSON.stringify({ schemaVersion: 1, installId: "../../unrelated" });
		await writeFile(pointer, content);
		await expect(service.ensureDesktopInstallation({ version: "0.12.8" })).rejects.toThrow(
			"selected desktop installation is invalid",
		);
		expect(await readFile(pointer, "utf8")).toBe(content);
	});

	it.each([{ version: "0.12.9" }, { arch: "x64" as const }, { launchProtocol: false }])(
		"rejects mismatched or old local app identity before copying: %s",
		async (options) => {
			const fixture = await createDesktopAppFixture(root, options);
			const { dependencies, commands } = createInstallerDependencies(root);
			await expect(
				createDesktopInstallationService(dependencies).ensureDesktopInstallation({
					version: "0.12.8",
					from: fixture.appPath,
				}),
			).rejects.toThrow();
			expect(commands.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
			expect(await readdir(join(dependencies.managedRoot, "installations"))).toEqual([]);
		},
	);

	it("rejects external app symlinks without copying or traversing the target", async () => {
		const fixture = await createDesktopAppFixture(root);
		await symlink(root, join(fixture.appPath, "escape"));
		const { dependencies } = createInstallerDependencies(root);
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({
				version: "0.12.8",
				from: fixture.appPath,
			}),
		).rejects.toThrow("external or invalid symbolic link");
	});

	it("preserves contained app aliases while copying and validating the managed app", async () => {
		const fixture = await createDesktopAppFixture(root);
		await symlink("runtime/dist/cli.js", join(fixture.appPath, "Contents/Resources/runtime-alias"));
		const { dependencies } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		expect((await lstat(join(installed.appPath, "Contents/Resources/runtime-alias"))).isSymbolicLink()).toBe(true);
		expect(await service.ensureDesktopInstallation({ version: "0.12.8" })).toEqual(installed);
	});

	it("refuses a selected app replaced with a symlink, even to matching app content", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8", from: fixture.appPath });
		const slot = join(dependencies.managedRoot, "installations", installed.installId);
		await chmod(slot, 0o700);
		await chmod(installed.appPath, 0o700);
		await rename(installed.appPath, join(slot, "retained.app"));
		await symlink(fixture.appPath, installed.appPath);
		await expect(service.ensureDesktopInstallation({ version: "0.12.8" })).rejects.toThrow("replaced by a link");
		expect(dependencies.download).not.toHaveBeenCalled();
	});

	it("rejects unsupported hosts and unsafe version inputs before filesystem effects", async () => {
		const { dependencies } = createInstallerDependencies(root);
		await expect(
			createDesktopInstallationService({ ...dependencies, platform: "linux" }).ensureDesktopInstallation({
				version: "0.12.8",
			}),
		).rejects.toThrow("native macOS");
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({ version: "../latest" }),
		).rejects.toThrow("exact npm version");
		expect(await readdir(root)).toEqual([]);
	});

	it("does not let a throwing progress observer change a completed installation", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = createInstallerDependencies(root);
		const service = createDesktopInstallationService(dependencies);
		const result = await service.ensureDesktopInstallation({
			version: "0.12.8",
			from: fixture.appPath,
			onProgress: () => {
				throw new Error("UI observer failed");
			},
		});
		expect(await service.ensureDesktopInstallation({ version: "0.12.8" })).toEqual(result);
	});
});
