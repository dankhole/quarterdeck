import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLanguageServerCommand } from "../../../src/language-navigation/command";
import { runtimeAppRouter } from "../../../src/trpc/app-router";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router-context";

vi.mock("../../../src/language-navigation/command", () => ({ checkLanguageServerCommand: vi.fn() }));

const caller = runtimeAppRouter.createCaller({} as RuntimeTrpcContext);

describe("checkLspCommand input boundary", () => {
	beforeEach(() => vi.mocked(checkLanguageServerCommand).mockReset());
	it("passes validated environment overrides into the filesystem-only command check", async () => {
		vi.mocked(checkLanguageServerCommand).mockResolvedValue({ available: true, message: "Found server." });
		await expect(
			caller.runtime.checkLspCommand({
				command: "server",
				env: { PATH: "/custom/bin", NODE_OPTIONS: "--no-warnings" },
			}),
		).resolves.toMatchObject({ available: true });
		expect(checkLanguageServerCommand).toHaveBeenCalledExactlyOnceWith("server", {
			PATH: "/custom/bin",
			NODE_OPTIONS: "--no-warnings",
		});
	});
	it("accepts commands up to the saved configuration limit", async () => {
		const command = "x".repeat(16_384);
		vi.mocked(checkLanguageServerCommand).mockResolvedValue({ available: false, message: "Not found." });
		await expect(caller.runtime.checkLspCommand({ command })).resolves.toMatchObject({ available: false });
		expect(checkLanguageServerCommand).toHaveBeenCalledExactlyOnceWith(command, undefined);
	});
	it.each(["", " ", "bad\0command", "x".repeat(16_385)])(
		"rejects invalid commands before checking",
		async (command) => {
			await expect(caller.runtime.checkLspCommand({ command })).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(checkLanguageServerCommand).not.toHaveBeenCalled();
		},
	);
	const invalidEnvironments: Record<string, string>[] = [
		{ "BAD=KEY": "value" },
		{ PATH: "bad\0path" },
		{ PATH: "x".repeat(16_385) },
	];
	it.each(invalidEnvironments)("rejects invalid environment values before checking", async (env) => {
		await expect(caller.runtime.checkLspCommand({ command: "server", env })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(checkLanguageServerCommand).not.toHaveBeenCalled();
	});
});
