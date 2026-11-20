import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getRuntimeHomePath } from "./core/runtime-state-home.js";
import { resolveDesktopInstallationOwner, validateDesktopInstallationForLaunch } from "./desktop-install/index.js";
import { resolveCanonicalRuntimeStateHome } from "./server/runtime-ownership.js";
import { hasGitRepository } from "./server/runtime-startup-paths.js";
import {
	DESKTOP_LAUNCH_ARGUMENT,
	DESKTOP_LAUNCH_PROTOCOL_VERSION,
	serializeDesktopLaunchRequest,
} from "./shared/desktop-launch-contract.js";
import { isUnderWorktreesHome } from "./state/project-state-utils.js";

const executeFile = promisify(execFile);

/** LaunchServices owns presentation; the CLI neither starts nor owns a runtime. */
export async function launchDesktop(version: string): Promise<void> {
	if (!["darwin", "win32"].includes(process.platform)) {
		throw new Error(
			"Quarterdeck requires the desktop app on macOS or Windows. Standalone browser access is no longer supported.",
		);
	}
	if (process.env.QUARTERDECK_DESKTOP_CHILD === "1") {
		throw new Error("A desktop runtime helper cannot launch another desktop app.");
	}
	const stateHome = await resolveCanonicalRuntimeStateHome(getRuntimeHomePath());
	const cwd = await realpath(process.cwd());
	const projectPath = !isUnderWorktreesHome(cwd) && (await hasGitRepository(cwd)) ? cwd : undefined;
	const owner = await resolveDesktopInstallationOwner();
	const installation = await validateDesktopInstallationForLaunch({ version, owner });
	const request = serializeDesktopLaunchRequest({
		schemaVersion: DESKTOP_LAUNCH_PROTOCOL_VERSION,
		version: installation.version,
		appPath: installation.appPath,
		arch: installation.arch,
		buildId: installation.buildId,
		appAsarSha256: installation.appAsarSha256,
		stateHome,
		...(projectPath ? { projectPath } : {}),
	});
	if (process.platform === "win32")
		await new Promise<void>((accept, reject) => {
			const child = spawn(join(installation.appPath, "Quarterdeck.exe"), [DESKTOP_LAUNCH_ARGUMENT, request], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.once("error", reject);
			child.once("spawn", () => {
				child.unref();
				accept();
			});
		});
	else
		await executeFile(
			"/usr/bin/open",
			["-n", "-a", installation.appPath, "--args", DESKTOP_LAUNCH_ARGUMENT, request],
			{
				timeout: 15_000,
				maxBuffer: 16_384,
			},
		);
	console.log(`Desktop launch requested: ${installation.appPath}`);
}
