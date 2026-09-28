import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLanguageServerCommand } from "../../src/language-navigation/command";
import { createTempDir } from "../utilities/temp-dir";

describe("language-server command checks", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("resolves a command using the configured PATH instead of the inherited PATH", async () => {
		vi.stubEnv("PATH", "");
		const command = basename(process.execPath);
		expect((await checkLanguageServerCommand(command)).available).toBe(false);
		expect((await checkLanguageServerCommand(command, { PATH: dirname(process.execPath) })).available).toBe(true);
	});

	it("honors an empty configured PATH even when the command is inherited", async () => {
		vi.stubEnv("PATH", dirname(process.execPath));
		const command = basename(process.execPath);
		expect((await checkLanguageServerCommand(command)).available).toBe(true);
		expect((await checkLanguageServerCommand(command, { PATH: "" })).available).toBe(false);
	});

	it.skipIf(process.platform !== "win32")("honors differently cased Windows Path overrides", async () => {
		vi.stubEnv("PATH", dirname(process.execPath));
		expect((await checkLanguageServerCommand(basename(process.execPath), { Path: "" })).available).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"inspects executability without starting the configured command",
		async () => {
			const temp = createTempDir("qd-lsp-check-");
			try {
				const marker = join(temp.path, "started");
				const command = join(temp.path, "synthetic-server");
				writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
				expect((await checkLanguageServerCommand("synthetic-server", { PATH: temp.path })).available).toBe(true);
				expect(existsSync(marker)).toBe(false);
				expect((await checkLanguageServerCommand("./synthetic-server", { PATH: temp.path })).available).toBe(false);
			} finally {
				temp.cleanup();
			}
		},
	);
});
