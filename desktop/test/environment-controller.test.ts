import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBoxOptions } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopEnvironmentController, type DesktopEnvironmentStatus } from "../src/environment-controller.js";
import {
	readDesktopEnvironmentPreferences,
	writeDesktopEnvironmentPreferences,
} from "../src/environment-preferences.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function setup(
	choices: number[],
	status: DesktopEnvironmentStatus = {
		ownership: "owned",
		source: "inherited",
		appliedDirectories: [],
		appliedImportLoginShellEnvironment: false,
	},
) {
	const userDataPath = await mkdtemp(join(tmpdir(), "quarterdeck-environment-dialog-"));
	roots.push(userDataPath);
	const messages: MessageBoxOptions[] = [];
	const showMessage = vi.fn(async (options: MessageBoxOptions) => {
		messages.push(options);
		return choices.shift() ?? 0;
	});
	const showFolders = vi.fn(async () => [join(userDataPath, "agent tools")]);
	const requestRefresh = vi.fn(async () => "refreshed" as const);
	const options = { userDataPath, getStatus: () => status, showMessage, showFolders, requestRefresh };
	return { options, controller: new DesktopEnvironmentController(options), messages, status };
}

describe("native runtime environment controller", () => {
	it.each([1, 2, 3, 4])("explains CLI attachment without exposing action %s", async (choice) => {
		const fixture = await setup([choice], { ownership: "attached", source: "inherited", appliedDirectories: [] });
		await fixture.controller.open();
		expect(fixture.messages[0]?.buttons).toEqual(["Close"]);
		expect(fixture.messages[0]?.detail).toContain("running Quarterdeck CLI");
		expect(fixture.options.showFolders).not.toHaveBeenCalled();
		expect(fixture.options.requestRefresh).not.toHaveBeenCalled();
	});

	it("shows shell-free defaults and discloses what enabling login-shell import allows", async () => {
		const fixture = await setup([0]);
		await fixture.controller.open();
		expect(fixture.messages[0]?.buttons).toEqual([
			"Close",
			"Add Folders…",
			"Reset Override",
			"Refresh Environment",
			"Enable Login-Shell Import",
		]);
		expect(fixture.messages[0]?.detail).toContain("Current login-shell import: Disabled");
		expect(fixture.messages[0]?.detail).toContain("Saved login-shell import: Disabled");
		expect(fixture.messages[0]?.detail).toContain("Saved settings match");
		expect(fixture.messages[0]?.detail).toContain(
			"When enabled, app startup and Refresh Environment run shell startup files",
		);
		expect(fixture.messages[0]?.detail).toContain("run commands and access Keychain");
		expect(fixture.messages[0]?.detail).toContain("stay in memory and are never saved");
		expect(fixture.options.requestRefresh).not.toHaveBeenCalled();
	});

	it("shows bounded source/failure guidance and saves folders pending explicit safe refresh", async () => {
		const fixture = await setup([1, 3, 0], {
			ownership: "owned",
			source: "fallback",
			failureReason: "capture_timeout",
			appliedDirectories: [],
			appliedImportLoginShellEnvironment: true,
		});
		await fixture.controller.open();
		expect(fixture.messages[0]?.detail).toContain("timed out");
		expect(fixture.options.showFolders).toHaveBeenCalledWith(
			expect.objectContaining({ properties: ["openDirectory", "multiSelections"] }),
		);
		expect(fixture.messages[1]?.detail).toContain("unapplied changes");
		expect(fixture.options.requestRefresh).toHaveBeenCalledOnce();
		await expect(readDesktopEnvironmentPreferences(fixture.options.userDataPath)).resolves.toEqual({
			version: 1,
			extraExecutableDirectories: [join(fixture.options.userDataPath, "agent tools")],
			importLoginShellEnvironment: false,
		});
		expect(fixture.messages.at(-1)?.message).toBe("Runtime environment refreshed");
	});

	it("reset removes only desktop folders, preserving login-shell import without refreshing", async () => {
		const fixture = await setup([2, 0]);
		await writeDesktopEnvironmentPreferences(fixture.options.userDataPath, {
			version: 1,
			extraExecutableDirectories: [join(fixture.options.userDataPath, "old")],
			importLoginShellEnvironment: true,
		});
		await fixture.controller.open();
		await expect(readDesktopEnvironmentPreferences(fixture.options.userDataPath)).resolves.toEqual({
			version: 1,
			extraExecutableDirectories: [],
			importLoginShellEnvironment: true,
		});
		expect(fixture.options.requestRefresh).not.toHaveBeenCalled();
	});

	it("adding folders preserves the saved login-shell import opt-in", async () => {
		const fixture = await setup([1, 0]);
		const oldFolder = join(fixture.options.userDataPath, "old");
		await writeDesktopEnvironmentPreferences(fixture.options.userDataPath, {
			version: 1,
			extraExecutableDirectories: [oldFolder],
			importLoginShellEnvironment: true,
		});
		await fixture.controller.open();
		await expect(readDesktopEnvironmentPreferences(fixture.options.userDataPath)).resolves.toEqual({
			version: 1,
			extraExecutableDirectories: [oldFolder, join(fixture.options.userDataPath, "agent tools")],
			importLoginShellEnvironment: true,
		});
		expect(fixture.options.requestRefresh).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"toggles saved login-shell import from %s without changing folders or refreshing",
		async (enabled) => {
			const fixture = await setup([4, 0]);
			const folder = join(fixture.options.userDataPath, "tools");
			await writeDesktopEnvironmentPreferences(fixture.options.userDataPath, {
				version: 1,
				extraExecutableDirectories: [folder],
				importLoginShellEnvironment: enabled,
			});
			await fixture.controller.open();
			await expect(readDesktopEnvironmentPreferences(fixture.options.userDataPath)).resolves.toEqual({
				version: 1,
				extraExecutableDirectories: [folder],
				importLoginShellEnvironment: !enabled,
			});
			expect(fixture.messages[1]?.detail).toContain(`Saved login-shell import: ${enabled ? "Disabled" : "Enabled"}`);
			expect(fixture.status.appliedImportLoginShellEnvironment).toBe(false);
			expect(fixture.options.requestRefresh).not.toHaveBeenCalled();
		},
	);

	it("reports an enabled import independently from inherited fallback after a capture failure", async () => {
		const fixture = await setup([0], {
			ownership: "owned",
			source: "fallback",
			failureReason: "capture_timeout",
			appliedDirectories: [],
			appliedImportLoginShellEnvironment: true,
		});
		await writeDesktopEnvironmentPreferences(fixture.options.userDataPath, {
			version: 1,
			extraExecutableDirectories: [],
			importLoginShellEnvironment: true,
		});
		await fixture.controller.open();
		expect(fixture.messages[0]?.detail).toContain("Environment source: Inherited fallback");
		expect(fixture.messages[0]?.detail).toContain("Current login-shell import: Enabled");
		expect(fixture.messages[0]?.detail).toContain("Saved settings match");
	});

	it("does not claim saved settings match before the current mode is applied", async () => {
		const fixture = await setup([0], { ownership: "none", source: "unresolved", appliedDirectories: [] });
		await fixture.controller.open();
		expect(fixture.messages[0]?.detail).toContain("Current login-shell import: Not applied yet");
		expect(fixture.messages[0]?.detail).toContain("unapplied changes");
	});

	it("allows explicit recovery of malformed saved settings with login-shell import disabled", async () => {
		const fixture = await setup([1, 0]);
		await mkdir(join(fixture.options.userDataPath, "environment-preferences"));
		await writeFile(join(fixture.options.userDataPath, "environment-preferences", "folders.json"), "malformed");
		await fixture.controller.open();
		expect(fixture.messages[0]?.buttons).toEqual(["Close", "Reset Saved Settings"]);
		expect(fixture.messages[0]?.detail).toContain("disable login-shell import");
		await expect(readDesktopEnvironmentPreferences(fixture.options.userDataPath)).resolves.toEqual({
			version: 1,
			extraExecutableDirectories: [],
			importLoginShellEnvironment: false,
		});
	});

	it("does not save after ownership changes while the folder picker is open", async () => {
		const fixture = await setup([1, 0]);
		fixture.options.showFolders.mockImplementation(async () => {
			fixture.status.ownership = "attached";
			return [join(fixture.options.userDataPath, "tools")];
		});
		await fixture.controller.open();
		await expect(readDesktopEnvironmentPreferences(fixture.options.userDataPath)).resolves.toEqual({
			version: 1,
			extraExecutableDirectories: [],
			importLoginShellEnvironment: false,
		});
		expect(fixture.options.requestRefresh).not.toHaveBeenCalled();
	});

	it("does not toggle saved login-shell import after ownership changes while the dialog is open", async () => {
		const fixture = await setup([]);
		fixture.options.showMessage.mockImplementation(async (options) => {
			fixture.messages.push(options);
			fixture.status.ownership = "attached";
			return 4;
		});
		await fixture.controller.open();
		await expect(readDesktopEnvironmentPreferences(fixture.options.userDataPath)).resolves.toEqual({
			version: 1,
			extraExecutableDirectories: [],
			importLoginShellEnvironment: false,
		});
		expect(fixture.messages.at(-1)?.message).toBe("This runtime belongs to the CLI");
		expect(fixture.options.requestRefresh).not.toHaveBeenCalled();
	});

	it("keeps the applied mode and saved pending mode separate after refresh is cancelled", async () => {
		const fixture = await setup([4, 3, 0]);
		const requestRefresh = vi.fn(async () => "cancelled" as const);
		const controller = new DesktopEnvironmentController({ ...fixture.options, requestRefresh });
		await controller.open();
		expect(requestRefresh).toHaveBeenCalledOnce();
		expect(fixture.status.appliedImportLoginShellEnvironment).toBe(false);
		await expect(readDesktopEnvironmentPreferences(fixture.options.userDataPath)).resolves.toEqual({
			version: 1,
			extraExecutableDirectories: [],
			importLoginShellEnvironment: true,
		});
		await controller.open();
		expect(fixture.messages.at(-1)?.detail).toContain("Current login-shell import: Disabled");
		expect(fixture.messages.at(-1)?.detail).toContain("Saved login-shell import: Enabled");
		expect(fixture.messages.at(-1)?.detail).toContain("unapplied changes");
		expect(fixture.messages.some((message) => message.message === "Runtime environment refreshed")).toBe(false);
	});

	it("does not claim refresh succeeded after cancellation or failure", async () => {
		const fixture = await setup([3]);
		const requestRefresh = vi.fn(async () => "cancelled" as const);
		await new DesktopEnvironmentController({ ...fixture.options, requestRefresh }).open();
		expect(fixture.messages).toHaveLength(1);
		const failed = await setup([3]);
		await new DesktopEnvironmentController({
			...failed.options,
			requestRefresh: async () => {
				throw new Error("secret environment content");
			},
		}).open();
		expect(failed.messages.at(-1)?.message).toBe("Runtime environment could not be refreshed");
		expect(JSON.stringify(failed.messages)).not.toContain("secret environment content");
	});

	it("coalesces repeated native menu requests into one dialog flow", async () => {
		const fixture = await setup([0]);
		const first = fixture.controller.open();
		const second = fixture.controller.open();
		expect(second).toBe(first);
		await first;
		expect(fixture.options.showMessage).toHaveBeenCalledOnce();
	});

	it.each(["refreshed", "cancelled", "failed"] as const)(
		"shows CLI ownership when attachment wins during a %s refresh",
		async (result) => {
			const fixture = await setup([3]);
			await new DesktopEnvironmentController({
				...fixture.options,
				requestRefresh: async () => {
					await Promise.resolve();
					fixture.status.ownership = "attached";
					return result;
				},
			}).open();
			expect(fixture.messages).toHaveLength(2);
			expect(fixture.messages.at(-1)?.message).toBe("This runtime belongs to the CLI");
			expect(fixture.messages.at(-1)?.detail).toContain("restart its runtime");
			expect(fixture.messages.some((message) => message.message === "Runtime environment refreshed")).toBe(false);
		},
	);
});
