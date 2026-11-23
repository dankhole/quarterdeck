import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { resolveWindowsPowerShellPath } from "../core/windows-system-paths.js";
import { DesktopInstallationError } from "./errors.js";
import { validateDesktopDirectoryAncestors } from "./path-safety.js";

const execute = promisify(execFile);
const script = [
	"$ErrorActionPreference='Stop'",
	"$path=[Environment]::GetEnvironmentVariable('QUARTERDECK_VERIFY_PRIVATE_PATH','Process')",
	"$acl=[IO.Directory]::GetAccessControl($path)",
	"$user=[Security.Principal.WindowsIdentity]::GetCurrent().User",
	"$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
	"if (-not $acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($user)) { exit 73 }",
	"$full=$false",
	"foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }; if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (-not $rule.IdentityReference.Equals($user) -and -not $rule.IdentityReference.Equals($system))) { exit 73 }; if ($rule.IdentityReference.Equals($user) -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $full=$true } }",
	"if (-not $full) { exit 73 }",
].join("; ");
const encoded = Buffer.from(script, "utf16le").toString("base64");

/** Validate recovery storage without repairing its permissions or following a junction. */
export async function assertDesktopPrivateDirectory(path: string): Promise<void> {
	await validateDesktopDirectoryAncestors(path);
	const info = await lstat(path);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		(process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
	)
		throw new DesktopInstallationError(
			"installation_changed",
			"Desktop transaction storage must be a real private directory.",
		);
	if (process.platform === "win32") {
		try {
			await execute(
				resolveWindowsPowerShellPath(),
				["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
				{
					env: { ...process.env, QUARTERDECK_VERIFY_PRIVATE_PATH: win32.toNamespacedPath(path) },
					timeout: 10000,
					windowsHide: true,
					maxBuffer: 4096,
				},
			);
		} catch {
			throw new DesktopInstallationError(
				"installation_changed",
				"Desktop transaction storage has an invalid Windows owner or DACL.",
			);
		}
	}
}
