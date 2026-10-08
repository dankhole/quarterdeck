import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRecoverCommand } from "../../../src/commands/recover.js";

const mocks = vi.hoisted(() => ({
	lease: { canonicalStateHome: "/synthetic/state" },
	inspect: vi.fn<() => Promise<{ recoveryRequired: boolean }>>(),
	acknowledge: vi.fn<() => Promise<void>>(),
	maintenance: vi.fn(),
	release: vi.fn(),
}));

vi.mock("../../../src/server/runtime-ownership.js", () => ({
	withRuntimeMaintenance: async (
		home: string,
		operation: (lease: typeof mocks.lease) => Promise<void>,
	): Promise<void> => {
		mocks.maintenance(home);
		try {
			await operation(mocks.lease);
		} finally {
			mocks.release();
		}
	},
}));
vi.mock("../../../src/server/runtime-recovery-acknowledgement.js", () => ({
	inspectRuntimeRecovery: mocks.inspect,
	acknowledgeRuntimeRecovery: mocks.acknowledge,
}));
vi.mock("../../../src/state/project-state-utils.js", () => ({ getRuntimeHomePath: () => "/synthetic/state" }));

describe("explicit recovery command", () => {
	let originalExitCode: NodeJS.Process["exitCode"];
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.inspect.mockResolvedValue({ recoveryRequired: true });
		mocks.acknowledge.mockResolvedValue(undefined);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
	});
	afterEach(() => {
		process.exitCode = originalExitCode;
		vi.restoreAllMocks();
	});

	async function run(...args: string[]): Promise<void> {
		const program = new Command();
		registerRecoverCommand(program);
		await program.parseAsync(["recover", ...args], { from: "user" });
	}

	it("inspects under maintenance ownership and requires explicit confirmation", async () => {
		await run();
		expect(mocks.maintenance).toHaveBeenCalledWith("/synthetic/state");
		expect(mocks.inspect).toHaveBeenCalledWith(mocks.lease);
		expect(mocks.acknowledge).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("quarterdeck recover --confirm-stopped"));
		expect(mocks.release).toHaveBeenCalledOnce();
	});

	it("records confirmation only after successful inspection", async () => {
		await run("--confirm-stopped");
		expect(mocks.inspect).toHaveBeenCalledOnce();
		expect(mocks.acknowledge).toHaveBeenCalledWith(mocks.lease);
		expect(mocks.inspect.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.acknowledge.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.release).toHaveBeenCalledOnce();
	});

	it("does not record a receipt on an already recoverable home", async () => {
		mocks.inspect.mockResolvedValue({ recoveryRequired: false });
		await run("--confirm-stopped");
		expect(mocks.acknowledge).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No recovery confirmation is needed"));
	});

	it("cannot use confirmation to bypass live or unreadable evidence", async () => {
		mocks.inspect.mockRejectedValue(new Error("Saved process is still live."));
		await run("--confirm-stopped");
		expect(mocks.acknowledge).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(mocks.release).toHaveBeenCalledOnce();
	});

	it("reports failed receipt publication as failure", async () => {
		mocks.acknowledge.mockRejectedValue(new Error("Cannot publish receipt."));
		await run("--confirm-stopped");
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Cannot publish receipt"));
	});
});
