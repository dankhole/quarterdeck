import { describe, expect, it } from "vitest";

import { pickDirectoryPathFromSystemDialog } from "../../src/server/directory-picker";

interface RecordedCommand {
	command: string;
	args: string[];
}

interface FakeDirectoryPickerResult {
	stdout: string;
	stderr: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

function createSpawnResult(overrides: Partial<FakeDirectoryPickerResult> = {}): FakeDirectoryPickerResult {
	return {
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		error: undefined,
		...overrides,
	};
}

function createRunCommand(
	responses: Record<string, FakeDirectoryPickerResult>,
	commands: RecordedCommand[],
): (command: string, args: string[]) => Promise<FakeDirectoryPickerResult> {
	return async (command: string, args: string[]) => {
		commands.push({ command, args });
		const response = responses[command];
		if (!response) {
			throw new Error(`Unexpected command: ${command}`);
		}
		return response;
	};
}

describe("pickDirectoryPathFromSystemDialog", () => {
	it("falls back to kdialog when zenity is unavailable on linux", async () => {
		const commands: RecordedCommand[] = [];
		const selectedPath = await pickDirectoryPathFromSystemDialog({
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

		expect(selectedPath).toEqual({ kind: "selected", path: "/tmp/my-repo" });
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

	it("returns null when the picker is cancelled", async () => {
		const commands: RecordedCommand[] = [];
		const selectedPath = await pickDirectoryPathFromSystemDialog({
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

		expect(selectedPath).toEqual({ kind: "cancelled" });
		expect(commands).toEqual([
			{
				command: "zenity",
				args: ["--file-selection", "--directory", "--title=Select project folder"],
			},
		]);
	});

	it("returns a typed unavailable result when no linux picker commands are installed", async () => {
		const commands: RecordedCommand[] = [];
		expect(
			await pickDirectoryPathFromSystemDialog({
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
		).toEqual({
			kind: "unavailable",
			error: 'Could not open directory picker. Install "zenity" or "kdialog" and try again.',
		});
	});

	it("throws command stderr when picker fails for a real error", async () => {
		await expect(
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
		).rejects.toThrow("Could not open directory picker via zenity: Gtk warning");
	});
});

it("uses powershell on windows when available", async () => {
	const commands: RecordedCommand[] = [];
	const selectedPath = await pickDirectoryPathFromSystemDialog({
		platform: "win32",
		runCommand: createRunCommand(
			{
				powershell: createSpawnResult({
					stdout: "C:\\Users\\dev\\repo\n",
				}),
			},
			commands,
		),
	});

	expect(selectedPath).toEqual({ kind: "selected", path: "C:\\Users\\dev\\repo" });
	expect(commands).toHaveLength(1);
	expect(commands[0]?.command).toBe("powershell");
	expect(commands[0]?.args.slice(0, 3)).toEqual(["-NoProfile", "-STA", "-Command"]);
});

it("falls back to pwsh when powershell is unavailable on windows", async () => {
	const commands: RecordedCommand[] = [];
	const selectedPath = await pickDirectoryPathFromSystemDialog({
		platform: "win32",
		runCommand: createRunCommand(
			{
				powershell: createSpawnResult({
					error: {
						code: "ENOENT",
						message: "command not found",
					} as NodeJS.ErrnoException,
				}),
				pwsh: createSpawnResult({
					stdout: "C:\\Users\\dev\\repo\n",
				}),
			},
			commands,
		),
	});

	expect(selectedPath).toEqual({ kind: "selected", path: "C:\\Users\\dev\\repo" });
	expect(commands.map((entry) => entry.command)).toEqual(["powershell", "pwsh"]);
});

it("returns null when windows picker is cancelled", async () => {
	const selectedPath = await pickDirectoryPathFromSystemDialog({
		platform: "win32",
		runCommand: createRunCommand(
			{
				powershell: createSpawnResult({
					status: 1,
				}),
			},
			[],
		),
	});

	expect(selectedPath).toEqual({ kind: "cancelled" });
});

it("returns a typed unavailable result when no windows picker commands are installed", async () => {
	expect(
		await pickDirectoryPathFromSystemDialog({
			platform: "win32",
			runCommand: createRunCommand(
				{
					powershell: createSpawnResult({
						error: {
							code: "ENOENT",
							message: "command not found",
						} as NodeJS.ErrnoException,
					}),
					pwsh: createSpawnResult({
						error: {
							code: "ENOENT",
							message: "command not found",
						} as NodeJS.ErrnoException,
					}),
				},
				[],
			),
		}),
	).toEqual({
		kind: "unavailable",
		error: 'Could not open directory picker. Install PowerShell ("powershell" or "pwsh") and try again.',
	});
});

it("uses osascript for a normal macOS picker", async () => {
	const commands: RecordedCommand[] = [];
	const selectedPath = await pickDirectoryPathFromSystemDialog({
		platform: "darwin",
		runCommand: createRunCommand(
			{
				osascript: createSpawnResult({ stdout: "/Users/dev/repo/\n" }),
			},
			commands,
		),
	});

	expect(selectedPath).toEqual({ kind: "selected", path: "/Users/dev/repo/" });
	expect(commands.map((entry) => entry.command)).toEqual(["osascript"]);
});
