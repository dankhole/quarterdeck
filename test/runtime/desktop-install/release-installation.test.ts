import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopInstallationService } from "../../../src/desktop-install/index.js";
import { validateDesktopReleaseManifest } from "../../../src/desktop-install/metadata.js";
import { createDesktopAppFixture, createInstallerDependencies } from "./fixture.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-release-install-test-"));
});
afterEach(async () => {
	async function writable(path: string): Promise<void> {
		const info = await lstat(path);
		if (info.isSymbolicLink()) return;
		await chmod(path, info.mode | 0o700);
		if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
	}
	await writable(root);
	await rm(root, { recursive: true, force: true });
});

describe("trusted desktop release installation", () => {
	it("downloads only the exact tagged manifest and matching DMG, verifies before copy, and reuses offline", async () => {
		const fixture = await createDesktopAppFixture(root, { signed: true });
		const { dependencies, commands } = createInstallerDependencies(root, fixture);
		const service = createDesktopInstallationService(dependencies);
		const installed = await service.ensureDesktopInstallation({ version: "0.12.8" });
		expect(installed.source).toBe("release");
		expect(vi.mocked(dependencies.download).mock.calls.map(([url]) => url)).toEqual([
			"https://github.com/dankhole/quarterdeck/releases/download/v0.12.8/artifact-manifest-darwin-arm64.json",
			"https://github.com/dankhole/quarterdeck/releases/download/v0.12.8/Quarterdeck-0.12.8-darwin-arm64.dmg",
		]);
		const attach = commands.find((call) => call.command === "/usr/bin/hdiutil" && call.args[0] === "attach");
		expect(attach?.args).toEqual(
			expect.arrayContaining(["-readonly", "-nobrowse", "-noautoopen", "-mountpoint", "-plist"]),
		);
		expect(commands.findIndex((call) => call.command === "/usr/sbin/spctl")).toBeLessThan(
			commands.findIndex((call) => call.command === "/usr/bin/ditto"),
		);
		expect(commands.filter((call) => call.command === "/usr/bin/hdiutil" && call.args[0] === "detach")).toHaveLength(
			1,
		);
		expect(
			commands.every((call) =>
				[
					"/usr/bin/plutil",
					"/usr/bin/lipo",
					"/usr/bin/hdiutil",
					"/usr/bin/codesign",
					"/usr/sbin/spctl",
					"/usr/bin/ditto",
				].includes(call.command),
			),
		).toBe(true);
		const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8"));
		expect(receipt).toMatchObject({ signing: { verified: true, teamId: "ABCDE12345" }, updatesEnabled: false });
		expect(await service.ensureDesktopInstallation({ version: "0.12.8" })).toEqual(installed);
		expect(dependencies.download).toHaveBeenCalledTimes(2);
		expect(await readdir(dependencies.managedRoot)).toEqual(["installations", "selections"]);
	});

	it("rejects corrupt containers before mounting or signature inspection", async () => {
		const fixture = await createDesktopAppFixture(root, { signed: true });
		const { dependencies, commands } = createInstallerDependencies(root, fixture);
		const original = dependencies.download;
		dependencies.download = vi.fn(async (url, destination, maximum) => {
			await original(url, destination, maximum);
			if (url.endsWith(".dmg")) await writeFile(destination, "corrupt");
		});
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({ version: "0.12.8" }),
		).rejects.toThrow("DMG checksum or byte length");
		expect(commands).toEqual([]);
		expect(await readdir(dependencies.managedRoot)).toEqual(["installations", "selections"]);
	});

	it("attempts private mount cleanup after attach fails and publishes no installation", async () => {
		const fixture = await createDesktopAppFixture(root, { signed: true });
		const { dependencies, commands } = createInstallerDependencies(root, fixture);
		const original = dependencies.runCommand;
		dependencies.runCommand = vi.fn(async (command, args) => {
			const result = await original(command, args);
			if (command === "/usr/bin/hdiutil" && args[0] === "attach") throw new Error("attach interrupted");
			return result;
		});
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({ version: "0.12.8" }),
		).rejects.toThrow("attach interrupted");
		expect(commands.filter((call) => call.command === "/usr/bin/hdiutil" && call.args[0] === "detach")).toHaveLength(
			1,
		);
		expect(commands.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
		expect(await readdir(join(dependencies.managedRoot, "installations"))).toEqual([]);
		expect(await readdir(dependencies.managedRoot)).toEqual(["installations", "selections"]);
	});

	it.each(["team", "gatekeeper"])(
		"refuses %s failures, detaches only its mount, and selects nothing",
		async (failure) => {
			const fixture = await createDesktopAppFixture(root, { signed: true });
			const { dependencies, commands } = createInstallerDependencies(root, fixture);
			const original = dependencies.runCommand;
			dependencies.runCommand = vi.fn(async (command, args) => {
				if (command === "/usr/sbin/spctl" && failure === "gatekeeper") throw new Error("Gatekeeper denied");
				if (command === "/usr/bin/codesign" && args[0] === "--display" && failure === "team")
					return {
						stdout: "",
						stderr:
							"Authority=Developer ID Application: Other\nTeamIdentifier=WRONG12345\nCodeDirectory flags=0x10000(runtime)\n",
					};
				return original(command, args);
			});
			await expect(
				createDesktopInstallationService(dependencies).ensureDesktopInstallation({ version: "0.12.8" }),
			).rejects.toThrow();
			expect(commands.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
			expect(
				commands.filter((call) => call.command === "/usr/bin/hdiutil" && call.args[0] === "detach"),
			).toHaveLength(1);
			expect(await readdir(join(dependencies.managedRoot, "selections"))).toEqual([]);
		},
	);

	it("requires signed public release policy even when metadata otherwise matches", async () => {
		const fixture = await createDesktopAppFixture(root, { signed: true });
		for (const mutation of [
			{ signedDistribution: false },
			{ sourceDirty: true },
			{ version: "0.12.9" },
			{ arch: "x64" },
			{ channel: "validation", validationFeedBase: "https://validation.example/" },
			{ productionUpdatesEnabled: false },
			{ desktopLaunchProtocolVersion: undefined },
			{ fuses: { ...fixture.manifest.fuses, EnableNodeCliInspectArguments: true } },
		])
			expect(() =>
				validateDesktopReleaseManifest({ ...fixture.manifest, ...mutation }, "0.12.8", "arm64"),
			).toThrow();
	});

	it("accepts signed preview policy only with production updates disabled", async () => {
		const fixture = await createDesktopAppFixture(root, { signed: true, version: "0.12.9-beta.1" });
		expect(validateDesktopReleaseManifest(fixture.manifest, "0.12.9-beta.1", "arm64").channel).toBe("preview");
		expect(() =>
			validateDesktopReleaseManifest(
				{ ...fixture.manifest, productionUpdatesEnabled: true },
				"0.12.9-beta.1",
				"arm64",
			),
		).toThrow();
	});

	it("checks mounted app resource hashes against the trusted manifest before copying", async () => {
		const fixture = await createDesktopAppFixture(root, { signed: true });
		await writeFile(join(fixture.appPath, "Contents/Resources/runtime/dist/cli.js"), "tampered runtime");
		const { dependencies, commands } = createInstallerDependencies(root, fixture);
		await expect(
			createDesktopInstallationService(dependencies).ensureDesktopInstallation({ version: "0.12.8" }),
		).rejects.toThrow("resource checksums");
		expect(commands.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
	});
});
