import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopLabDriver } from "../../../scripts/agent-lab/desktop-driver";
import {
	type DesktopSessionRecoverySeed,
	exerciseDesktopSessionRecovery,
} from "../../../scripts/agent-lab/desktop-session-recovery";
import { writeJsonAtomic } from "../../../scripts/agent-lab/paths";
import type { RuntimeOwnershipClaim } from "../../../src/core/api/runtime-management";
import { discoverRuntimeOwner, readPriorRuntimeOwnershipClaims } from "../../../src/server/runtime-ownership";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(async () => "retained evidence"),
	readdir: vi.fn(async () => []),
	lstat: vi.fn(),
}));
vi.mock("../../../scripts/agent-lab/paths", () => ({
	AGENT_LAB_REPO_ROOT: "/synthetic/repo",
	writeJsonAtomic: vi.fn(),
}));
vi.mock("../../../src/server/runtime-ownership", () => ({
	discoverRuntimeOwner: vi.fn(),
	readPriorRuntimeOwnershipClaims: vi.fn(),
}));

function claim(generation: string, previousGeneration: string | null): RuntimeOwnershipClaim {
	return {
		version: 1,
		generation,
		canonicalStateHome: "/synthetic/fixture/state",
		hostIdentity: "synthetic-host",
		bootIdentity: "darwin:synthetic-boot",
		custodyProtocolVersion: 1,
		purpose: "runtime",
		previousGeneration,
		process: { pid: 50_001, creationIdentity: "synthetic-birth" },
		claimedAt: "2026-10-08T00:00:00.000Z",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("packaged session recovery intercepted navigation", () => {
	it("activates the exact DOM action, verifies Cancel, and restores its scoped native callback after failure", async () => {
		const seeded = claim("11111111-1111-4111-8111-111111111111", null);
		const blocked = claim("22222222-2222-4222-8222-222222222222", seeded.generation);
		vi.mocked(discoverRuntimeOwner).mockResolvedValue({
			claim: blocked,
			descriptor: null,
			processState: "dead",
			released: false,
		});
		vi.mocked(readPriorRuntimeOwnershipClaims).mockResolvedValue([
			{ claim: seeded, released: false, custodyDirty: true },
		]);
		const original = vi.fn(() => 0);
		const native = {
			app: {
				isPackaged: true,
				getAppPath: () => "/synthetic/Quarterdeck.app/Contents/Resources/app.asar",
				getPath: () => "/synthetic/fixture/user-data",
				__quarterdeckLabSessionRecoveryDialog: original,
			},
			BrowserWindow: {
				getAllWindows: () => [
					{
						isVisible: () => false,
						isFocused: () => false,
						webContents: { getURL: () => "app://quarterdeck/__desktop/error" },
					},
				],
			},
		};
		let clicks = 0;
		const failure = new Error("confirmation fixture intentionally unavailable");
		const domClick = vi.fn(() => {
			clicks++;
			if (clicks === 2) throw failure;
			const dialog: unknown = Reflect.get(native.app, "__quarterdeckLabSessionRecoveryDialog");
			if (typeof dialog !== "function") throw new Error("Recovery dialog interception was not installed.");
			expect(
				dialog({
					title: "Recover sessions",
					message: "Have prior agents and background commands stopped?",
					buttons: ["Cancel", "Confirm Stopped and Recover"],
					defaultId: 0,
					cancelId: 0,
				}),
			).toBe(0);
		});
		vi.stubGlobal("location", { href: "app://quarterdeck/__desktop/error" });
		vi.stubGlobal("document", {
			querySelectorAll: () => [
				{ href: "app://quarterdeck/__desktop/recover", textContent: "Recover sessions…", click: domClick },
			],
		});
		const recoveryLink = {
			waitFor: vi.fn(async () => {}),
			click: vi.fn(),
		};
		const page = {
			url: () => "app://quarterdeck/__desktop/error",
			getByRole: (role: string) => (role === "link" ? recoveryLink : { isVisible: async () => false }),
			evaluate: async (operation: (argument: unknown) => unknown, argument: unknown) => operation(argument),
		} as unknown as Page;
		const inspect = vi.fn(async () => {});
		const driver = {
			fixture: {
				config: { stateHome: "/synthetic/fixture/state", userDataPath: "/synthetic/fixture/user-data" },
				manifest: { appPath: "/synthetic/Quarterdeck.app", artifactDir: "/synthetic/artifacts" },
			},
			inspect,
			app: {
				evaluate: async (operation: (module: unknown, argument: unknown) => unknown, argument?: unknown) =>
					operation(native, argument),
			},
		} as unknown as DesktopLabDriver;
		const seed: DesktopSessionRecoverySeed = {
			claim: seeded,
			claimText: "retained evidence",
			dirtyText: "retained evidence",
			sessionsPath: "/synthetic/fixture/state/projects/fixture/sessions.json",
			sessionsText: "retained evidence",
		};
		await expect(exerciseDesktopSessionRecovery(page, driver, seed)).rejects.toBe(failure);
		expect(domClick).toHaveBeenCalledTimes(2);
		expect(recoveryLink.click).not.toHaveBeenCalled();
		expect(inspect).toHaveBeenCalledExactlyOnceWith("session-recovery-blocked");
		expect(native.app.__quarterdeckLabSessionRecoveryDialog).toBe(original);
		expect(Reflect.has(native.app, "__quarterdeckLabSessionRecoveryObservation")).toBe(false);
		expect(writeJsonAtomic).toHaveBeenCalledExactlyOnceWith("/synthetic/artifacts/session-recovery-dialogs.json", {
			dialogs: [expect.objectContaining({ response: 0, defaultId: 0, cancelId: 0 })],
		});
	});
});
