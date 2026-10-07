import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDesktopCommand } from "../../../src/commands/desktop.js";
import { ensureDesktopInstallation } from "../../../src/desktop-install/index.js";

vi.mock("../../../src/desktop-install/index.js", () => ({ ensureDesktopInstallation: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("desktop install command", () => {
	it("preserves an explicitly empty local path for installer rejection", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.mocked(ensureDesktopInstallation).mockRejectedValue(new Error("The --from option requires an explicit path."));
		const program = new Command().exitOverride();
		registerDesktopCommand(program, "0.12.8");
		await expect(program.parseAsync(["desktop", "install", "--from", ""], { from: "user" })).rejects.toThrow(
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
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.mocked(ensureDesktopInstallation).mockResolvedValue({
				appPath: "/synthetic/installed/Quarterdeck.app",
				version: "0.12.8",
				arch: "arm64",
				source: from ? "local" : "release",
				installId: "synthetic",
				buildId: "synthetic",
				appAsarSha256: "a".repeat(64),
				receiptPath: "/synthetic/receipt.json",
			});
			const program = new Command().exitOverride();
			registerDesktopCommand(program, "0.12.8");
			await program.parseAsync(["desktop", "install", ...(from ? ["--from", from] : [])], { from: "user" });
			expect(ensureDesktopInstallation).toHaveBeenLastCalledWith({
				version: "0.12.8",
				...(from ? { from } : {}),
				onProgress: expect.any(Function),
			});
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("quarterdeck --desktop"));
		},
	);
});
