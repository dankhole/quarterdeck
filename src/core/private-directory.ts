import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { mergeProcessEnvironment } from "./process-environment.js";
import { terminateProcessForTimeout } from "./process-termination.js";
import { resolveWindowsPowerShellPath } from "./windows-system-paths.js";

const PRIVATE_PATHS_ENVIRONMENT_KEY = "QUARTERDECK_PRIVATE_PATHS";
const WINDOWS_ACL_TIMEOUT_MS = 10_000;

const WINDOWS_PRIVATE_DIRECTORY_ACL_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	`$serializedPaths = [Environment]::GetEnvironmentVariable('${PRIVATE_PATHS_ENVIRONMENT_KEY}', 'Process')`,
	"if ([string]::IsNullOrWhiteSpace($serializedPaths)) { throw 'Missing private paths.' }",
	"$paths = @(ConvertFrom-Json -InputObject $serializedPaths)",
	"$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
	"$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
	"$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
	"$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
	"$propagation = [System.Security.AccessControl.PropagationFlags]::None",
	"$allow = [System.Security.AccessControl.AccessControlType]::Allow",
	"foreach ($path in $paths) { $acl = Get-Acl -LiteralPath $path; $acl.SetAccessRuleProtection($true, $false); foreach ($existingRule in @($acl.Access)) { $acl.RemoveAccessRuleAll($existingRule) }; $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($owner, $rights, $inheritance, $propagation, $allow)); $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, $rights, $inheritance, $propagation, $allow)); Set-Acl -LiteralPath $path -AclObject $acl }",
].join("; ");
const WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_SCRIPT = Buffer.from(
	WINDOWS_PRIVATE_DIRECTORY_ACL_SCRIPT,
	"utf16le",
).toString("base64");

export interface WindowsPrivateAclCommandResult {
	ok: boolean;
}

export type WindowsPrivateAclCommandRunner = (paths: readonly string[]) => Promise<WindowsPrivateAclCommandResult>;

export interface EnsurePrivateDirectoryOptions {
	platform?: NodeJS.Platform;
	runWindowsAclCommand?: WindowsPrivateAclCommandRunner;
}

export class PrivateDirectoryAclError extends Error {
	readonly code = "PrivateDirectoryAclError";

	constructor() {
		super("Could not apply a private Windows ACL to protected storage.");
		this.name = "PrivateDirectoryAclError";
	}
}

function runPowerShellAclCommand(command: string, paths: readonly string[]): Promise<WindowsPrivateAclCommandResult> {
	return new Promise((resolve) => {
		let timeout: NodeJS.Timeout | null = null;
		const child = execFile(
			command,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_SCRIPT,
			],
			{
				encoding: "utf8",
				env: mergeProcessEnvironment(process.env, {
					[PRIVATE_PATHS_ENVIRONMENT_KEY]: JSON.stringify(paths),
				}),
				windowsHide: true,
			},
			(error: ExecFileException | null) => {
				if (timeout) clearTimeout(timeout);
				resolve({ ok: error === null });
			},
		);
		timeout = setTimeout(() => terminateProcessForTimeout(child), WINDOWS_ACL_TIMEOUT_MS);
		timeout.unref();
	});
}

async function defaultRunWindowsAclCommand(paths: readonly string[]): Promise<WindowsPrivateAclCommandResult> {
	return await runPowerShellAclCommand(resolveWindowsPowerShellPath(), paths);
}

/** Creates protected directories before sensitive or integrity-critical content is written. */
export async function ensurePrivateDirectory(path: string, options: EnsurePrivateDirectoryOptions = {}): Promise<void> {
	await ensurePrivateDirectories([path], options);
}

/**
 * Installs one exact protected DACL for all requested Windows directories.
 * POSIX platforms retain an owner-only mode contract.
 */
export async function ensurePrivateDirectories(
	paths: readonly string[],
	options: EnsurePrivateDirectoryOptions = {},
): Promise<void> {
	const uniquePaths = [...new Set(paths)];
	if (uniquePaths.length === 0) return;
	await Promise.all(uniquePaths.map(async (path) => await mkdir(path, { recursive: true, mode: 0o700 })));
	if ((options.platform ?? process.platform) !== "win32") {
		await Promise.all(uniquePaths.map(async (path) => await chmod(path, 0o700)));
		return;
	}

	const result = await (options.runWindowsAclCommand ?? defaultRunWindowsAclCommand)(uniquePaths);
	if (!result.ok) throw new PrivateDirectoryAclError();
}
