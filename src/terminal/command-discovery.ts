import { spawnSync } from "node:child_process";

function getShellBinary(): string | null {
	if (process.platform === "win32") {
		return process.env.ComSpec?.trim() || "cmd.exe";
	}
	const shell = process.env.SHELL?.trim();
	return shell || "/bin/bash";
}

function quotePosixWord(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function isBinaryAvailableOnPath(binary: string): boolean {
	const trimmed = binary.trim();
	if (!trimmed) {
		return false;
	}
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return true;
	}
	const lookupCommand = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(lookupCommand, [trimmed], {
		stdio: "ignore",
	});
	return result.status === 0;
}

export function isBinaryResolvableInShell(binary: string): boolean {
	const trimmed = binary.trim();
	if (!trimmed) {
		return false;
	}
	const shellBinary = getShellBinary();
	if (!shellBinary) {
		return false;
	}
	if (process.platform === "win32") {
		const result = spawnSync(shellBinary, ["/d", "/s", "/c", `where ${trimmed} >NUL 2>NUL`], {
			stdio: "ignore",
		});
		return result.status === 0;
	}
	const result = spawnSync(shellBinary, ["-ic", `command -v ${quotePosixWord(trimmed)} >/dev/null 2>&1`], {
		stdio: "ignore",
	});
	return result.status === 0;
}

export function isCommandAvailable(command: string): boolean {
	return isBinaryAvailableOnPath(command) || isBinaryResolvableInShell(command);
}

export function toShellLaunchCommand(commandLine: string): { binary: string; args: string[] } | null {
	const trimmed = commandLine.trim();
	if (!trimmed) {
		return null;
	}
	const shellBinary = getShellBinary();
	if (!shellBinary) {
		return null;
	}
	if (process.platform === "win32") {
		return {
			binary: shellBinary,
			args: ["/d", "/s", "/c", trimmed],
		};
	}
	return {
		binary: shellBinary,
		args: ["-ic", trimmed],
	};
}
