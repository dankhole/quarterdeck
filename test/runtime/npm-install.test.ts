import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDesktopInstallation, getDesktopInstallationStatus } from "../../src/desktop-install/index.js";
import {
	formatLegacyDesktopMigrationGuidance,
	inventoryLegacyDesktopInstallations,
} from "../../src/desktop-install/legacy.js";
import {
	installNpmDesktopPair,
	type NpmInstallContext,
	npmInstallRecoveryMessage,
	resolveNpmInstallPolicy,
} from "../../src/npm-install.js";

vi.mock("../../src/desktop-install/index.js", () => ({
	ensureDesktopInstallation: vi.fn(),
	getDesktopInstallationStatus: vi.fn(),
	resolveDesktopInstallationOwner: vi.fn(),
}));
vi.mock("../../src/desktop-install/legacy.js", () => ({
	inventoryLegacyDesktopInstallations: vi.fn(),
	formatLegacyDesktopMigrationGuidance: vi.fn(),
}));

const owner = {
	kind: "npm" as const,
	packageRoot: "/synthetic/prefix/lib/node_modules/quarterdeck",
	packageSlot: "/synthetic/prefix/lib/node_modules/quarterdeck",
	prefix: "/synthetic/prefix",
	identity: {
		schemaVersion: 1 as const,
		version: "0.12.8",
		buildId: "11111111-1111-4111-8111-111111111111",
		sourceSha: "a".repeat(40),
		sourceDirty: false,
	},
};
const installation = {
	appPath: "/synthetic/Applications/Quarterdeck.app",
	version: "0.12.8",
	arch: "arm64" as const,
	source: "release" as const,
	installId: "11111111-1111-4111-8111-111111111111",
	buildId: owner.identity.buildId,
	appAsarSha256: "a".repeat(64),
	receiptPath: "/synthetic/installation/receipt.json",
	owner,
	generation: "synthetic",
	cleanupPending: false,
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.mocked(ensureDesktopInstallation).mockResolvedValue(installation);
	vi.mocked(inventoryLegacyDesktopInstallations).mockResolvedValue({
		root: "/synthetic/legacy",
		pending: false,
		truncated: false,
		retained: [],
	});
	vi.mocked(formatLegacyDesktopMigrationGuidance).mockReturnValue([]);
});
afterEach(() => vi.restoreAllMocks());

const supported: NpmInstallContext = {
	env: {
		QUARTERDECK_INSTALL_MODE: "desktop",
		npm_config_global: "true",
		npm_command: "install",
		npm_lifecycle_event: "postinstall",
		HOME: "/synthetic/user",
	},
	platform: "darwin",
	arch: "arm64",
	osRelease: "25.0.0",
	uid: 501,
	sourceCheckout: false,
	graphicalSession: true,
	desktopRelease: false,
};

describe("npm lifecycle installation policy", () => {
	it("accepts an ordinary Windows user without POSIX uid or HOME", () => {
		expect(
			resolveNpmInstallPolicy({
				...supported,
				platform: "win32",
				osRelease: "10.0.26100",
				uid: undefined,
				env: { ...supported.env, HOME: undefined, USERPROFILE: "C:\\Users\\synthetic" },
			}),
		).toEqual({ action: "install" });
	});
	it("installs only for an explicit supported global user installation", () => {
		expect(resolveNpmInstallPolicy(supported)).toEqual({ action: "install" });
	});
	it("enables automatic installation only for desktop-capable releases", () => {
		const env = { ...supported.env, QUARTERDECK_INSTALL_MODE: undefined };
		expect(resolveNpmInstallPolicy({ ...supported, env, desktopRelease: false })).toEqual({ action: "skip" });
		expect(resolveNpmInstallPolicy({ ...supported, env, desktopRelease: true })).toEqual({ action: "install" });
		expect(
			resolveNpmInstallPolicy({
				...supported,
				env: { ...env, QUARTERDECK_INSTALL_MODE: "browser" },
				desktopRelease: true,
			}),
		).toEqual({ action: "install" });
	});
	it("uses the public ad-hoc capability for automatic install and explicit npm updates", () => {
		const env = { ...supported.env, QUARTERDECK_INSTALL_MODE: undefined };
		expect(resolveNpmInstallPolicy({ ...supported, env, desktopRelease: undefined })).toEqual({ action: "install" });
		expect(
			resolveNpmInstallPolicy({
				...supported,
				env: { ...supported.env, npm_command: "update" },
				desktopRelease: undefined,
			}),
		).toEqual({ action: "install" });
	});
	it.each([
		{ graphicalSession: false },
		{ env: { ...supported.env, QUARTERDECK_INSTALL_MODE: undefined, SSH_CONNECTION: "remote" } },
		{ env: { ...supported.env, QUARTERDECK_INSTALL_MODE: undefined, SSH_TTY: "/dev/ttys001" } },
	])("skips automatic app effects in headless or SSH installations: %j", (override) => {
		const context = { ...supported, desktopRelease: true, ...override };
		context.env = { ...context.env, QUARTERDECK_INSTALL_MODE: undefined };
		expect(resolveNpmInstallPolicy(context)).toEqual({ action: "skip" });
	});
	it("accepts the shipped in-app updater's explicit desktop mode for headless global npm updates", () => {
		expect(
			resolveNpmInstallPolicy({
				...supported,
				env: { ...supported.env, npm_command: "update", QUARTERDECK_INSTALL_MODE: "desktop" },
				graphicalSession: false,
			}),
		).toEqual({ action: "install" });
	});
	it("retains explicit desktop installation without a GUI while preserving ordinary-user admission", () => {
		expect(resolveNpmInstallPolicy({ ...supported, graphicalSession: false })).toEqual({ action: "install" });
		expect(resolveNpmInstallPolicy({ ...supported, graphicalSession: false, uid: 0 }).action).toBe("reject");
	});
	it.each([
		{ npm_config_global: "false" },
		{ npm_config_global: undefined },
		{ npm_command: "link" },
		{ npm_command: "ci" },
		{ CI: "true" },
		{ QUARTERDECK_INSTALL_MODE: undefined },
		{ QUARTERDECK_INSTALL_MODE: "" },
		{ QUARTERDECK_INSTALL_MODE: "browser" },
		{ QUARTERDECK_INSTALL_MODE: "unknown" },
		{ npm_lifecycle_event: "prepare" },
	])("skips dependency/source/link/CI and non-desktop contexts %j before installer effects", (env) => {
		expect(resolveNpmInstallPolicy({ ...supported, env: { ...supported.env, ...env } })).toEqual({ action: "skip" });
	});
	it.each([
		{ sourceCheckout: true },
		{ platform: "linux" },
		{ platform: "win32", osRelease: "6.3.0" },
		{ osRelease: "21.0" },
		{ arch: "ia32" },
	])("skips unsupported and source contexts %j", (override) => {
		expect(resolveNpmInstallPolicy({ ...supported, ...override })).toEqual({ action: "skip" });
	});
	it.each([
		{ uid: 0 },
		{ uid: undefined },
		{ env: { ...supported.env, SUDO_USER: "user" } },
		{ env: { ...supported.env, HOME: "relative" } },
	])("rejects root and ambiguous users %j", (override) => {
		expect(resolveNpmInstallPolicy({ ...supported, ...override }).action).toBe("reject");
	});
	it("reports exact recovery even if npm removes the CLI", () => {
		const guidance = npmInstallRecoveryMessage("0.12.8", "Quit and retry");
		expect(guidance).toContain(
			`${process.platform === "win32" ? "$env:QUARTERDECK_INSTALL_MODE='desktop';" : "QUARTERDECK_INSTALL_MODE=desktop"} npm install -g quarterdeck@0.12.8 --foreground-scripts`,
		);
		expect(guidance).toContain("quarterdeck desktop install");
		expect(guidance).toContain("--replace-owner");
		expect(guidance).not.toContain("INSTALL_MODE=browser");
		expect(guidance).toContain("skipping scripts does not install a working app");
	});
});

describe("npm desktop installation completion", () => {
	it("accepts a completed pair without repeating verification", async () => {
		await expect(installNpmDesktopPair("0.12.8", owner)).resolves.toBeUndefined();
		expect(ensureDesktopInstallation).toHaveBeenCalledWith({ version: "0.12.8", owner });
		expect(getDesktopInstallationStatus).not.toHaveBeenCalled();
		expect(console.warn).not.toHaveBeenCalled();
	});

	it.each([
		{ state: "incomplete" as const, pending: true },
		{ state: "changed" as const, pending: false },
		{ state: "ready" as const, pending: true },
	])("rejects cleanup that leaves the pair unusable: %j", async (status) => {
		vi.mocked(ensureDesktopInstallation).mockResolvedValue({ ...installation, cleanupPending: true });
		vi.mocked(getDesktopInstallationStatus).mockResolvedValue({ ...status, message: "Required repair" });
		await expect(installNpmDesktopPair("0.12.8", owner)).rejects.toMatchObject({
			code: "incomplete_installation",
			message: expect.stringContaining("Required repair"),
		});
		expect(getDesktopInstallationStatus).toHaveBeenCalledWith({ owner });
		expect(inventoryLegacyDesktopInstallations).not.toHaveBeenCalled();
	});

	it("warns honestly when only cleanup residue remains and the pair is usable", async () => {
		vi.mocked(ensureDesktopInstallation).mockResolvedValue({ ...installation, cleanupPending: true });
		vi.mocked(getDesktopInstallationStatus).mockResolvedValue({
			state: "ready",
			pending: false,
			installation,
			message: "Ready",
		});
		await expect(installNpmDesktopPair("0.12.8", owner)).resolves.toBeUndefined();
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('inspect retained installer files under "/synthetic/installation"'),
		);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("quarterdeck desktop status"));
	});
});
