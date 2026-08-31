import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { mergeProcessEnvironment } from "./process-environment.js";
import { terminateProcessForTimeout } from "./process-termination.js";
import { resolveWindowsPowerShellPath } from "./windows-system-paths.js";

const PRIVATE_PATHS_ENVIRONMENT_KEY = "QUARTERDECK_PRIVATE_PATHS";
const WINDOWS_ACL_TIMEOUT_MS = 10_000;
const WINDOWS_ACL_FAILURE_PREFIX = "QUARTERDECK_ACL_FAILURE|";

// A fresh DirectorySecurity marks only Access as modified, so .NET Framework replaces the DACL
// without rewriting owner/group metadata or depending on PowerShell module autoloading.
const WINDOWS_PRIVATE_DIRECTORY_ACL_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	`trap { $failure = $_.Exception; while ($failure.InnerException) { $failure = $failure.InnerException }; [Console]::Error.WriteLine('${WINDOWS_ACL_FAILURE_PREFIX}' + $failure.GetType().FullName + '|' + $_.FullyQualifiedErrorId); exit 1 }`,
	`$serializedPaths = [Environment]::GetEnvironmentVariable('${PRIVATE_PATHS_ENVIRONMENT_KEY}', 'Process')`,
	"if ([string]::IsNullOrWhiteSpace($serializedPaths)) { throw 'Missing private paths.' }",
	"$paths = @(ConvertFrom-Json -InputObject $serializedPaths)",
	"$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
	"$accessSection = [System.Security.AccessControl.AccessControlSections]::Access",
	"$privateDacl = 'D:P(A;OICI;FA;;;' + $owner.Value + ')(A;OICI;FA;;;SY)'",
	"foreach ($path in $paths) { $acl = [System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetSecurityDescriptorSddlForm($privateDacl, $accessSection); [System.IO.Directory]::SetAccessControl($path, $acl) }",
].join("; ");
const WINDOWS_PRIVATE_DIRECTORY_ACL_ENCODED_SCRIPT = Buffer.from(
	WINDOWS_PRIVATE_DIRECTORY_ACL_SCRIPT,
	"utf16le",
).toString("base64");

export interface WindowsPrivateAclCommandResult {
	ok: boolean;
	failureCode?: string;
}

export type WindowsPrivateAclCommandRunner = (paths: readonly string[]) => Promise<WindowsPrivateAclCommandResult>;

export interface EnsurePrivateDirectoryOptions {
	platform?: NodeJS.Platform;
	runWindowsAclCommand?: WindowsPrivateAclCommandRunner;
}

export class PrivateDirectoryAclError extends Error {
	readonly code = "PrivateDirectoryAclError";
	readonly failureCode?: string;

	constructor(failureCode?: string) {
		super(formatPrivateDirectoryAclErrorMessage(failureCode));
		this.name = "PrivateDirectoryAclError";
		this.failureCode = normalizeWindowsAclFailureCode(failureCode);
	}
}

function formatPrivateDirectoryAclErrorMessage(failureCode: string | undefined): string {
	const normalizedFailureCode = normalizeWindowsAclFailureCode(failureCode);
	return normalizedFailureCode
		? `Could not apply a private Windows ACL to protected storage (${normalizedFailureCode}).`
		: "Could not apply a private Windows ACL to protected storage.";
}

function normalizeWindowsAclFailureCode(candidate: string | undefined): string | undefined {
	const normalized = candidate?.trim();
	return normalized && /^[a-z0-9_.+`-]+\|[a-z0-9_.+,`-]+$/iu.test(normalized) ? normalized.slice(0, 240) : undefined;
}

function parseWindowsAclFailureCode(stderr: string): string | undefined {
	const markerIndex = stderr.indexOf(WINDOWS_ACL_FAILURE_PREFIX);
	if (markerIndex < 0) return undefined;
	const candidate = stderr
		.slice(markerIndex + WINDOWS_ACL_FAILURE_PREFIX.length)
		.split(/\r?\n/u, 1)[0]
		?.trim();
	return normalizeWindowsAclFailureCode(candidate);
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
			(error: ExecFileException | null, _stdout: string, stderr: string) => {
				if (timeout) clearTimeout(timeout);
				resolve({ ok: error === null, failureCode: error ? parseWindowsAclFailureCode(stderr) : undefined });
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
	if (!result.ok) throw new PrivateDirectoryAclError(result.failureCode);
}
