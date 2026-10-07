import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { getRuntimeHomePath } from "../../src/core/runtime-state-home.js";
import { resolveCanonicalRuntimeStateHome } from "../../src/server/runtime-ownership.js";
import { type DesktopLaunchRequest, desktopLaunchRequestSchema } from "../../src/shared/desktop-launch-contract.js";
import { type DesktopLabLaunchConfig, readLabLaunchConfig } from "./lab-launch-config.js";

export interface DesktopRuntimeLaunchConfig {
	stateHome: string;
	projectPath: string;
	synthetic: boolean;
	hostSimulationConfigPath?: string;
}

export interface DesktopLaunchConfig extends DesktopRuntimeLaunchConfig {
	userDataPath: string;
	lab: DesktopLabLaunchConfig | null;
	request: DesktopLaunchRequest | null;
}

/** Recheck filesystem identity before a launch may select a profile or pass to another instance. */
export async function validateDesktopLaunchRequest(
	value: unknown,
	lab: DesktopLabLaunchConfig | null = null,
): Promise<DesktopLaunchRequest> {
	const request = desktopLaunchRequestSchema.parse(value);
	if ((await resolveCanonicalRuntimeStateHome(request.stateHome)) !== request.stateHome)
		throw new Error("Quarterdeck desktop launch requires a canonical state home. Run quarterdeck --desktop again.");
	if (lab && request.stateHome !== lab.stateHome)
		throw new Error("Agent Lab desktop launch requires its exact isolated state home.");
	if (request.projectPath !== undefined) {
		if (
			(await realpath(request.projectPath)) !== request.projectPath ||
			!(await stat(request.projectPath)).isDirectory()
		)
			throw new Error(
				"Quarterdeck desktop launch project is unavailable. Run quarterdeck --desktop from its repository again.",
			);
		if (lab) {
			const projectRelative = relative(lab.tempRoot, request.projectPath);
			if (
				!projectRelative ||
				projectRelative === ".." ||
				projectRelative.startsWith(`..${sep}`) ||
				isAbsolute(projectRelative)
			)
				throw new Error("Agent Lab desktop launch project escapes its temporary root.");
		}
	}
	return request;
}

/** Electron preferences follow canonical runtime identity without creating runtime-owned storage. */
export async function readDesktopLaunchConfig(
	labConfigPath: string | undefined,
	defaultUserDataPath: string,
	request: DesktopLaunchRequest | null = null,
): Promise<DesktopLaunchConfig> {
	if (labConfigPath !== undefined) {
		const lab = readLabLaunchConfig(labConfigPath);
		const validatedRequest = request ? await validateDesktopLaunchRequest(request, lab) : null;
		return { ...lab, synthetic: true, lab, request: validatedRequest };
	}
	const validatedRequest = request ? await validateDesktopLaunchRequest(request) : null;
	const stateHome = validatedRequest?.stateHome ?? (await resolveCanonicalRuntimeStateHome(getRuntimeHomePath()));
	const profile = createHash("sha256").update(stateHome).digest("hex").slice(0, 32);
	const userDataPath = join(defaultUserDataPath, "profiles", profile);
	mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
	return {
		stateHome,
		projectPath: homedir(),
		userDataPath,
		synthetic: false,
		lab: null,
		request: validatedRequest,
	};
}
