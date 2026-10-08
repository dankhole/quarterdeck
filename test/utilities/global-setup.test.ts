import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";

import setup from "../global-setup";

vi.mock("esbuild", () => ({ build: vi.fn() }));

describe("root test home", { concurrent: false }, () => {
	beforeEach(() =>
		vi.mocked(build).mockResolvedValue({
			errors: [],
			warnings: [],
			outputFiles: undefined,
			metafile: undefined,
			mangleCache: undefined,
		}),
	);
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetAllMocks();
	});

	it("starts workers with a synthetic home and no inherited state override", () => {
		expect(basename(process.env.HOME ?? "")).toMatch(/^quarterdeck-suite-home-/);
		expect(process.env.USERPROFILE).toBe(process.env.HOME);
		expect(homedir()).toBe(process.env.HOME);
		expect(process.env.QUARTERDECK_STATE_HOME).toBeUndefined();
		expect(process.env.QUARTERDECK_DESKTOP_SESSION_ID).toBeUndefined();
	});

	it("provides disposable builds only for an opted-in run and removes every artifact", async () => {
		const provide = vi.fn<TestProject["provide"]>();
		const previousHome = process.env.HOME;
		const project = { getProvidedContext: () => ({ compileIntegrationCli: true }), provide };
		const teardown = await setup(project);
		const home = process.env.HOME ?? "";
		const directory = vi.mocked(build).mock.calls[0]?.[0].outdir ?? "";
		try {
			expect(directory).toMatch(/integration-cli-/);
			expect(build).toHaveBeenCalledWith(expect.objectContaining({ bundle: true, packages: "external" }));
			expect(provide).toHaveBeenCalledWith(
				"compiledIntegrationEntrypoints",
				expect.objectContaining({
					"src/cli.ts": join(directory, "cli.mjs"),
					"test/utilities/runtime-recovery-child.ts": join(directory, "runtime-recovery-child.mjs"),
				}),
			);
			expect(existsSync(join(directory, "terminal/pi-lifecycle-extension.runtime.js"))).toBe(true);
		} finally {
			await teardown();
		}
		expect(existsSync(directory)).toBe(false);
		expect(existsSync(home)).toBe(false);
		expect(process.env.HOME).toBe(previousHome);
	});

	it("removes the partial build and synthetic home when compilation fails", async () => {
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const failure = new Error("Synthetic build failure");
		vi.mocked(build).mockRejectedValueOnce(failure);
		const provide = vi.fn<TestProject["provide"]>();
		const starting = setup({ getProvidedContext: () => ({ compileIntegrationCli: true }), provide });
		const home = process.env.HOME ?? "";
		await expect(starting).rejects.toBe(failure);
		const directory = vi.mocked(build).mock.calls[0]?.[0].outdir ?? "";
		expect(existsSync(directory)).toBe(false);
		expect(existsSync(home)).toBe(false);
		expect(provide).not.toHaveBeenCalled();
		expect(process.env.HOME).toBe(previousHome);
		expect(process.env.USERPROFILE).toBe(previousUserProfile);
	});

	it.each(["present", "absent"] as const)("cleans up and restores %s original home values", async (original) => {
		vi.stubEnv("HOME", original === "present" ? process.env.HOME : undefined);
		vi.stubEnv("USERPROFILE", original === "present" ? process.env.USERPROFILE : undefined);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const teardown = setup();
		const temporaryHome = process.env.HOME ?? "";
		try {
			expect(temporaryHome).not.toBe(previousHome);
			expect(process.env.USERPROFILE).toBe(temporaryHome);
			writeFileSync(join(temporaryHome, "fixture.txt"), "synthetic test data");
		} finally {
			await teardown();
		}
		expect(existsSync(temporaryHome)).toBe(false);
		expect(process.env.HOME).toBe(previousHome);
		expect(process.env.USERPROFILE).toBe(previousUserProfile);
	});
});
