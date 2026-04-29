import { spawn } from "node:child_process";

interface DirectoryPickerCommandCandidate {
	command: string;
	args: string[];
}

type DirectoryPickerCommandResult =
	| { kind: "selected"; path: string }
	| { kind: "cancelled" }
	| { kind: "unavailable" };

export interface DirectoryPickerCommandProcessResult {
	stdout: string;
	stderr: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

type RunCommand = (command: string, args: string[]) => Promise<DirectoryPickerCommandProcessResult>;

interface PickDirectoryPathFromSystemDialogOptions {
	platform?: NodeJS.Platform;
	cwd?: string;
	runCommand?: RunCommand;
}

const WINDOWS_DIRECTORY_PICKER_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Windows.Forms",
	"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
	"$dialog.Description = 'Select a project folder'",
	"$dialog.ShowNewFolderButton = $false",
	"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
].join("; ");

function parseChildProcessErrorCode(error: unknown): string | null {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return null;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" ? code : null;
}

function defaultRunCommand(command: string, args: string[]): Promise<DirectoryPickerCommandProcessResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const resolveOnce = (result: DirectoryPickerCommandProcessResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(result);
		};

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string | Buffer) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk: string | Buffer) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			resolveOnce({
				stdout,
				stderr,
				status: null,
				signal: null,
				error,
			});
		});
		child.on("close", (status, signal) => {
			resolveOnce({
				stdout,
				stderr,
				status,
				signal,
			});
		});
	});
}

async function runDirectoryPickerCommand(
	candidate: DirectoryPickerCommandCandidate,
	runCommand: RunCommand,
): Promise<DirectoryPickerCommandResult> {
	const result = await runCommand(candidate.command, candidate.args);

	const errorCode = parseChildProcessErrorCode(result.error);
	if (errorCode === "ENOENT") {
		return { kind: "unavailable" };
	}

	if (result.error) {
		const message = result.error.message || String(result.error);
		throw new Error(`Could not open directory picker via ${candidate.command}: ${message}`);
	}

	if (result.signal) {
		throw new Error(`Directory picker command ${candidate.command} terminated by signal: ${result.signal}`);
	}

	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		if (stderr) {
			const stderrLower = stderr.toLowerCase();
			if (stderrLower.includes("user cancel") || stderrLower.includes("(-128)")) {
				return { kind: "cancelled" };
			}
			throw new Error(`Could not open directory picker via ${candidate.command}: ${stderr}`);
		}
		return { kind: "cancelled" };
	}

	const selectedPath = typeof result.stdout === "string" ? result.stdout.trim() : "";
	if (!selectedPath) {
		return { kind: "cancelled" };
	}

	return { kind: "selected", path: selectedPath };
}

export async function pickDirectoryPathFromSystemDialog(
	options: PickDirectoryPathFromSystemDialogOptions = {},
): Promise<string | null> {
	const platform = options.platform ?? process.platform;
	const cwd = options.cwd ?? process.cwd();
	const runCommand = options.runCommand ?? defaultRunCommand;

	if (platform === "darwin") {
		const result = await runDirectoryPickerCommand(
			{
				command: "osascript",
				args: ["-e", 'POSIX path of (choose folder with prompt "Select a project folder")'],
			},
			runCommand,
		);
		if (result.kind === "selected") {
			return result.path;
		}
		if (result.kind === "cancelled") {
			return null;
		}
		throw new Error('Could not open directory picker. Command "osascript" is not available.');
	}

	if (platform === "linux") {
		const candidates: DirectoryPickerCommandCandidate[] = [
			{
				command: "zenity",
				args: ["--file-selection", "--directory", "--title=Select project folder"],
			},
			{
				command: "kdialog",
				args: ["--getexistingdirectory", cwd, "Select project folder"],
			},
		];

		for (const candidate of candidates) {
			const result = await runDirectoryPickerCommand(candidate, runCommand);
			if (result.kind === "unavailable") {
				continue;
			}
			if (result.kind === "selected") {
				return result.path;
			}
			return null;
		}

		throw new Error('Could not open directory picker. Install "zenity" or "kdialog" and try again.');
	}

	if (platform === "win32") {
		const candidates: DirectoryPickerCommandCandidate[] = [
			{
				command: "powershell",
				args: ["-NoProfile", "-STA", "-Command", WINDOWS_DIRECTORY_PICKER_SCRIPT],
			},
			{
				command: "pwsh",
				args: ["-NoProfile", "-STA", "-Command", WINDOWS_DIRECTORY_PICKER_SCRIPT],
			},
		];

		for (const candidate of candidates) {
			const result = await runDirectoryPickerCommand(candidate, runCommand);
			if (result.kind === "unavailable") {
				continue;
			}
			if (result.kind === "selected") {
				return result.path;
			}
			return null;
		}

		throw new Error('Could not open directory picker. Install PowerShell ("powershell" or "pwsh") and try again.');
	}

	return null;
}
