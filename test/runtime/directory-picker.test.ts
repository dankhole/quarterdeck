import type { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { pickDirectoryPathFromSystemDialog } from "../../src/server/directory-picker.js";

interface RecordedCommand {
	command: string;
	args: string[];
}

function createSpawnResult(overrides: Partial<ReturnType<typeof spawnSync>> = {}): ReturnType<typeof spawnSync> {
	return {
		pid: 1,
		output: [null, "", ""],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		error: undefined,
		...overrides,
	};
}

function createRunCommand(
	responses: Record<string, ReturnType<typeof spawnSync>>,
	commands: RecordedCommand[],
): (command: string, args: string[]) => ReturnType<typeof spawnSync> {
	return (command: string, args: string[]) => {
		commands.push({ command, args });
		const response = responses[command];
		if (!response) {
			throw new Error(`Unexpected command: ${command}`);
		}
		return response;
	};
}

describe("pickDirectoryPathFromSystemDialog", () => {
	it("falls back to kdialog when zenity is unavailable on linux", () => {
		const commands: RecordedCommand[] = [];
		const selectedPath = pickDirectoryPathFromSystemDialog({
			platform: "linux",
			cwd: "/tmp",
			runCommand: createRunCommand(
				{
					zenity: createSpawnResult({
						error: {
							code: "ENOENT",
							message: "command not found",
						} as NodeJS.ErrnoException,
					}),
					kdialog: createSpawnResult({
						stdout: "/tmp/my-repo\n",
					}),
				},
				commands,
			),
		});

		expect(selectedPath).toBe("/tmp/my-repo");
		expect(commands).toEqual([
			{
				command: "zenity",
				args: ["--file-selection", "--directory", "--title=Select project folder"],
			},
			{
				command: "kdialog",
				args: ["--getexistingdirectory", "/tmp", "Select project folder"],
			},
		]);
	});

	it("returns null when the picker is cancelled", () => {
		const commands: RecordedCommand[] = [];
		const selectedPath = pickDirectoryPathFromSystemDialog({
			platform: "linux",
			runCommand: createRunCommand(
				{
					zenity: createSpawnResult({
						status: 1,
					}),
				},
				commands,
			),
		});

		expect(selectedPath).toBeNull();
		expect(commands).toEqual([
			{
				command: "zenity",
				args: ["--file-selection", "--directory", "--title=Select project folder"],
			},
		]);
	});

	it("throws a clear error when no linux picker commands are installed", () => {
		const commands: RecordedCommand[] = [];
		expect(() =>
			pickDirectoryPathFromSystemDialog({
				platform: "linux",
				runCommand: createRunCommand(
					{
						zenity: createSpawnResult({
							error: {
								code: "ENOENT",
								message: "command not found",
							} as NodeJS.ErrnoException,
						}),
						kdialog: createSpawnResult({
							error: {
								code: "ENOENT",
								message: "command not found",
							} as NodeJS.ErrnoException,
						}),
					},
					commands,
				),
			}),
		).toThrow('Could not open directory picker. Install "zenity" or "kdialog" and try again.');
	});

	it("throws command stderr when picker fails for a real error", () => {
		expect(() =>
			pickDirectoryPathFromSystemDialog({
				platform: "linux",
				runCommand: createRunCommand(
					{
						zenity: createSpawnResult({
							status: 1,
							stderr: "Gtk warning",
						}),
					},
					[],
				),
			}),
		).toThrow("Could not open directory picker via zenity: Gtk warning");
	});
});
