import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasManagedDesktopInstallationReceipt } from "../src/desktop-update-proof.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("npm-managed app updater marker", () => {
	it("uses the sidecar independently of launch arguments and fails closed for corrupt markers", async () => {
		const root = await realpath(await mkdtemp("/tmp/quarterdeck-managed-updater-"));
		roots.push(root);
		const appPath = join(root, "Quarterdeck.app");
		await mkdir(appPath);
		expect(await hasManagedDesktopInstallationReceipt(appPath)).toBe(false);
		for (const marker of [
			JSON.stringify({ schemaVersion: 1, managedBy: "quarterdeck-npm", updatesEnabled: false }),
			"corrupted",
		]) {
			await writeFile(join(root, "managed-installation.json"), marker);
			expect(await hasManagedDesktopInstallationReceipt(appPath)).toBe(true);
		}
		await mkdir(join(root, "Applications"));
		const alias = join(root, "Applications", "Quarterdeck.app");
		await symlink(appPath, alias);
		expect(await hasManagedDesktopInstallationReceipt(alias)).toBe(true);
	});
});
