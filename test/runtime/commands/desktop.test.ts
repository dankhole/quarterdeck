import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDesktopCommand } from "../../../src/commands/desktop.js";
import {
	ensureDesktopInstallation,
	getDesktopInstallationStatus,
	resolveDesktopInstallationOwner,
	uninstallDesktopInstallation,
} from "../../../src/desktop-install/index.js";
import {
	formatLegacyDesktopMigrationGuidance,
	inventoryLegacyDesktopInstallations,
} from "../../../src/desktop-install/legacy.js";

vi.mock("../../../src/desktop-install/index.js", () => ({
	ensureDesktopInstallation: vi.fn(),
	getDesktopInstallationStatus: vi.fn(),
	resolveDesktopInstallationOwner: vi.fn(),
	uninstallDesktopInstallation: vi.fn(),
}));
vi.mock("../../../src/desktop-install/legacy.js", () => ({
	formatLegacyDesktopMigrationGuidance: vi.fn(),
	inventoryLegacyDesktopInstallations: vi.fn(),
}));
const owner = {
	kind: "link" as const,
	packageSlot: "/synthetic/prefix/lib/node_modules/quarterdeck",
	packageRoot: "/synthetic/checkout",
	prefix: "/synthetic/prefix",
	identity: {
		schemaVersion: 1 as const,
		version: "0.12.8",
		buildId: "00000000-0000-4000-8000-000000000000",
		sourceSha: "a".repeat(40),
		sourceDirty: true,
	},
};
const installation = {
	appPath: "/synthetic/Applications/Quarterdeck.app",
	version: "0.12.8",
	arch: "arm64" as const,
	source: "local" as const,
	installId: "synthetic",
	buildId: owner.identity.buildId,
	appAsarSha256: "a".repeat(64),
	receiptPath: "/synthetic/receipt.json",
	owner,
	cleanupPending: false,
};
function program(): Command {
	const command = new Command().exitOverride();
	registerDesktopCommand(command, "0.12.8");
	return command;
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.mocked(ensureDesktopInstallation).mockResolvedValue(installation);
	vi.mocked(inventoryLegacyDesktopInstallations).mockResolvedValue({
		root: "/synthetic/legacy",
		pending: false,
		truncated: false,
		retained: [],
	});
	vi.mocked(formatLegacyDesktopMigrationGuidance).mockReturnValue([]);
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

describe("desktop maintenance commands", () => {
	it("preserves an explicitly empty local path for installer rejection", async () => {
		vi.mocked(ensureDesktopInstallation).mockRejectedValue(new Error("The --from option requires an explicit path."));
		await expect(program().parseAsync(["desktop", "install", "--from", ""], { from: "user" })).rejects.toThrow(
			"requires an explicit path",
		);
		expect(ensureDesktopInstallation).toHaveBeenLastCalledWith({
			version: "0.12.8",
			from: "",
			onProgress: expect.any(Function),
		});
		expect(console.log).not.toHaveBeenCalled();
	});
	it.each([undefined, "/synthetic/Quarterdeck Ω.app"])(
		"selects the CLI version and explicit candidate %s",
		async (from) => {
			await program().parseAsync(["desktop", "install", ...(from ? ["--from", from] : [])], { from: "user" });
			expect(ensureDesktopInstallation).toHaveBeenLastCalledWith({
				version: "0.12.8",
				...(from ? { from } : {}),
				onProgress: expect.any(Function),
			});
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Run quarterdeck"));
		},
	);
	it("makes owner transfer explicit and preserves the supplied linked prefix identity", async () => {
		vi.mocked(resolveDesktopInstallationOwner).mockResolvedValue(owner);
		await program().parseAsync(
			[
				"desktop",
				"install",
				"--replace-owner",
				"--owner-package-slot",
				owner.packageSlot,
				"--owner-prefix",
				owner.prefix,
			],
			{ from: "user" },
		);
		expect(resolveDesktopInstallationOwner).toHaveBeenCalledWith({
			packageRoot: expect.any(String),
			packageSlot: owner.packageSlot,
			prefix: owner.prefix,
			kind: "link",
		});
		expect(ensureDesktopInstallation).toHaveBeenCalledWith({
			version: "0.12.8",
			owner,
			replaceOwner: true,
			onProgress: expect.any(Function),
		});
	});
	it("rejects incomplete local owner arguments before installation", async () => {
		await expect(
			program().parseAsync(["desktop", "install", "--owner-prefix", owner.prefix], { from: "user" }),
		).rejects.toThrow("both");
		expect(ensureDesktopInstallation).not.toHaveBeenCalled();
	});
	it("reports status through the readonly API without installation", async () => {
		vi.mocked(getDesktopInstallationStatus).mockResolvedValue({
			state: "ready",
			installation,
			message: "Ready",
			pending: false,
		});
		await program().parseAsync(["desktop", "status"], { from: "user" });
		expect(getDesktopInstallationStatus).toHaveBeenCalledWith();
		expect(ensureDesktopInstallation).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith(`npm prefix: ${owner.prefix}`);
	});
	it("reports pending recovery and delegates removal to ownership/in-use checks", async () => {
		vi.mocked(getDesktopInstallationStatus).mockResolvedValue({
			state: "incomplete",
			message: "Run quarterdeck desktop install",
			pending: true,
		});
		await program().parseAsync(["desktop", "status"], { from: "user" });
		expect(console.log).toHaveBeenCalledWith("Desktop installation: incomplete (pending operation)");
		vi.mocked(uninstallDesktopInstallation).mockResolvedValue({
			removed: true,
			message: "Removed owned app; all user data preserved.",
		});
		await program().parseAsync(["desktop", "uninstall"], { from: "user" });
		expect(uninstallDesktopInstallation).toHaveBeenCalledWith();
		expect(console.log).toHaveBeenCalledWith("Removed owned app; all user data preserved.");
	});
	it("prints exactly one machine-readable status without legacy inventory", async () => {
		const status = { state: "ready" as const, installation, message: "Ready", pending: false };
		vi.mocked(getDesktopInstallationStatus).mockResolvedValue(status);
		await program().parseAsync(["desktop", "status", "--json"], { from: "user" });
		expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(status));
		expect(inventoryLegacyDesktopInstallations).not.toHaveBeenCalled();
		expect(ensureDesktopInstallation).not.toHaveBeenCalled();
		expect(process.exitCode).not.toBe(1);
	});
	it.each([
		{ state: "incomplete" as const, message: "Repair required", pending: true },
		{ state: "ready" as const, installation, message: "Cleanup pending", pending: true },
		{ state: "missing" as const, message: "No app", pending: false },
	])("returns a failing exit status for JSON status $state (pending=$pending)", async (status) => {
		vi.mocked(getDesktopInstallationStatus).mockResolvedValue(status);
		await program().parseAsync(["desktop", "status", "--json"], { from: "user" });
		expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(status));
		expect(process.exitCode).toBe(1);
		expect(inventoryLegacyDesktopInstallations).not.toHaveBeenCalled();
	});
	it.each(["install", "status", "uninstall"])(
		"reports retained legacy migration separately after %s",
		async (action) => {
			vi.mocked(getDesktopInstallationStatus).mockResolvedValue({
				state: "ready",
				installation,
				message: "Ready",
				pending: false,
			});
			vi.mocked(uninstallDesktopInstallation).mockResolvedValue({ removed: true, message: "Removed new app" });
			vi.mocked(formatLegacyDesktopMigrationGuidance).mockReturnValue([
				"Legacy desktop migration pending: retained /synthetic/old.app",
			]);
			await program().parseAsync(["desktop", action], { from: "user" });
			expect(inventoryLegacyDesktopInstallations).toHaveBeenCalledWith();
			expect(console.log).toHaveBeenCalledWith("Legacy desktop migration pending: retained /synthetic/old.app");
		},
	);
});
