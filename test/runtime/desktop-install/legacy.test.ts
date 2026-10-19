import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	formatLegacyDesktopMigrationGuidance,
	inventoryLegacyDesktopInstallations,
} from "../../../src/desktop-install/legacy.js";

const installId = "11111111-1111-4111-8111-111111111111";
const receipt = {
	schemaVersion: 1,
	managedBy: "quarterdeck-npm",
	installId,
	version: "0.12.8",
	arch: "arm64",
	source: "local",
	appPath: "Quarterdeck.app",
	bundleId: "io.github.dankhole.quarterdeck",
	buildId: "22222222-2222-4222-8222-222222222222",
	appAsarSha256: "a".repeat(64),
	appTreeSha256: "b".repeat(64),
	desktopLaunchProtocolVersion: 1,
	updatesEnabled: false,
	signing: { verified: false, teamId: null },
	release: null,
};

let home: string;
let root: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "quarterdeck-legacy-inventory-"));
	root = join(home, "Library/Application Support/Quarterdeck/managed-apps");
});
afterEach(async () => rm(home, { recursive: true, force: true }));

async function createLegacyInstallation(value: unknown = receipt): Promise<string> {
	const slot = join(root, "installations", installId);
	await mkdir(join(slot, "Quarterdeck.app"), { recursive: true });
	await writeFile(join(slot, "managed-installation.json"), JSON.stringify(value));
	return slot;
}

describe("read-only legacy desktop inventory", () => {
	it("does not create absent legacy metadata or claim migration work", async () => {
		expect(await inventoryLegacyDesktopInstallations(home)).toEqual({
			root,
			pending: false,
			truncated: false,
			retained: [],
		});
		expect(await readdir(home)).toEqual([]);
	});

	it("reports exact receipt and selection paths while preserving old app bytes and user profiles", async () => {
		const slot = await createLegacyInstallation();
		const appPath = join(slot, "Quarterdeck.app");
		await writeFile(join(appPath, "sentinel"), "old app bytes");
		const profile = join(home, "Library/Application Support/Quarterdeck/profile.json");
		await writeFile(profile, "old profile and drafts");
		await mkdir(join(root, "selections"));
		const selection = join(root, "selections/0.12.8-darwin-arm64.json");
		await writeFile(selection, JSON.stringify({ schemaVersion: 1, installId }));
		const inventory = await inventoryLegacyDesktopInstallations(home);
		expect(inventory.pending).toBe(true);
		expect(inventory.retained).toEqual([
			{ path: slot, appPath, kind: "installation", message: expect.stringContaining("remain unverified") },
			{ path: selection, kind: "selection", message: expect.stringContaining("target not followed") },
		]);
		expect(await readFile(join(appPath, "sentinel"), "utf8")).toBe("old app bytes");
		expect(await readFile(profile, "utf8")).toBe("old profile and drafts");
		const guidance = formatLegacyDesktopMigrationGuidance(inventory).join("\n");
		expect(guidance).toContain(JSON.stringify(appPath));
		expect(guidance).toContain("does not complete migration");
		expect(guidance).toContain("Remove the old Quarterdeck Dock shortcut");
		expect(guidance).toContain("~/Applications/Quarterdeck.app");
		expect(guidance).toContain("after verifying their identity and that they are unused");
	});

	it.each([
		{ ...receipt, installId: "33333333-3333-4333-8333-333333333333" },
		{ ...receipt, appPath: "../../outside.app" },
		{ ...receipt, schemaVersion: 999, secret: "must not appear in guidance" },
	])("retains malformed or mismatched receipts without trusting embedded app paths", async (invalid) => {
		const slot = await createLegacyInstallation(invalid);
		const inventory = await inventoryLegacyDesktopInstallations(home);
		expect(inventory.retained).toEqual([{ path: slot, kind: "uncertain", message: expect.any(String) }]);
		expect(formatLegacyDesktopMigrationGuidance(inventory).join("\n")).not.toContain("must not appear in guidance");
	});

	it.skipIf(process.platform === "win32")(
		"retains linked slots, receipts, apps, and selection files without following targets",
		async () => {
			const slot = await createLegacyInstallation();
			const outside = join(home, "outside");
			await mkdir(outside);
			await writeFile(join(outside, "private.json"), JSON.stringify({ secret: "outside metadata" }));
			await rm(join(slot, "managed-installation.json"));
			await symlink(join(outside, "private.json"), join(slot, "managed-installation.json"));
			const linkedSlot = join(root, "installations/33333333-3333-4333-8333-333333333333");
			await symlink(outside, linkedSlot, "dir");
			const linkedAppSlot = join(root, "installations/44444444-4444-4444-8444-444444444444");
			await mkdir(linkedAppSlot);
			await writeFile(
				join(linkedAppSlot, "managed-installation.json"),
				JSON.stringify({ ...receipt, installId: "44444444-4444-4444-8444-444444444444" }),
			);
			await symlink(outside, join(linkedAppSlot, "Quarterdeck.app"), "dir");
			await mkdir(join(root, "selections"));
			await symlink(join(outside, "private.json"), join(root, "selections/0.12.8-darwin-arm64.json"));
			const inventory = await inventoryLegacyDesktopInstallations(home);
			expect(inventory.retained).toHaveLength(4);
			expect(inventory.retained.every((entry) => entry.kind === "uncertain" && !entry.appPath)).toBe(true);
			expect(formatLegacyDesktopMigrationGuidance(inventory).join("\n")).not.toContain("outside metadata");
			expect(await readdir(outside)).toEqual(["private.json"]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"stops at a linked ancestor instead of enumerating external data",
		async () => {
			await mkdir(join(home, "external"));
			await writeFile(join(home, "external", "sentinel"), "external data");
			await symlink(join(home, "external"), join(home, "Library"), "dir");
			const inventory = await inventoryLegacyDesktopInstallations(home);
			expect(inventory.retained).toEqual([
				{ path: join(home, "Library"), kind: "uncertain", message: expect.stringContaining("without following") },
			]);
		},
	);

	it("bounds metadata bytes and directory entries and reports retained uncertainty", async () => {
		const slot = await createLegacyInstallation();
		await writeFile(join(slot, "managed-installation.json"), " ".repeat(16 * 1024 + 1));
		await mkdir(join(root, "selections"));
		await Promise.all(
			Array.from({ length: 110 }, (_, index) =>
				writeFile(join(root, "selections", `unknown-${index}`), "not metadata"),
			),
		);
		const inventory = await inventoryLegacyDesktopInstallations(home);
		expect(inventory.truncated).toBe(true);
		expect(inventory.retained.length).toBeLessThanOrEqual(101);
		expect(inventory.retained).toContainEqual({ path: slot, kind: "uncertain", message: expect.any(String) });
		expect(inventory.retained.some((entry) => entry.message.includes("inventory limit reached"))).toBe(true);
		expect(await readdir(join(root, "selections"))).toHaveLength(110);
	});

	it.skipIf(process.platform === "win32")(
		"does not block when legacy metadata was replaced with a special file",
		async () => {
			const slot = await createLegacyInstallation();
			const metadata = join(slot, "managed-installation.json");
			await rm(metadata);
			const created = spawnSync("/usr/bin/mkfifo", [metadata], { encoding: "utf8", timeout: 1000 });
			expect(created.status, created.stderr).toBe(0);
			const inventory = await inventoryLegacyDesktopInstallations(home);
			expect(inventory.retained).toEqual([{ path: slot, kind: "uncertain", message: expect.any(String) }]);
		},
	);

	it("quotes untrusted names and never enumerates unrelated app or data directories", async () => {
		await mkdir(join(root, "installations"), { recursive: true });
		const name = "unknown\nentry";
		await writeFile(join(root, "installations", name), "not metadata");
		await mkdir(join(root, "unrelated/Quarterdeck.app"), { recursive: true });
		const inventory = await inventoryLegacyDesktopInstallations(home);
		expect(inventory.retained).toHaveLength(1);
		const guidance = formatLegacyDesktopMigrationGuidance(inventory);
		expect(guidance[1]).toContain("unknown\\nentry");
		expect(guidance[1]).not.toContain("unknown\nentry");
		expect(guidance.join("\n")).not.toContain("unrelated");
	});
});
