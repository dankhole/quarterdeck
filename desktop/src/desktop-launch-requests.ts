import {
	type DesktopLaunchAppIdentity,
	type DesktopLaunchRequest,
	desktopLaunchRequestSchema,
} from "../../src/shared/desktop-launch-contract.js";

export type DesktopLaunchIdentity = DesktopLaunchAppIdentity & { stateHome: string };

export function desktopLaunchRefusal(value: unknown, identity: DesktopLaunchIdentity | null): string | null {
	const parsed = desktopLaunchRequestSchema.safeParse(value);
	if (!parsed.success) return "The desktop launch request is invalid. Run quarterdeck --desktop again.";
	if (!identity)
		return "The running Quarterdeck app does not support npm launch requests. Quit it, install a current app with quarterdeck desktop install, then run quarterdeck --desktop again.";
	if (parsed.data.version !== identity.version)
		return `The running Quarterdeck app is version ${identity.version}, but npm requested ${parsed.data.version}. Quit the running app, then run quarterdeck --desktop again.`;
	if (parsed.data.stateHome !== identity.stateHome)
		return "The running Quarterdeck app uses a different state home. Quit it and run quarterdeck --desktop again with the intended QUARTERDECK_STATE_HOME.";
	if (
		parsed.data.appPath !== identity.appPath ||
		parsed.data.arch !== identity.arch ||
		parsed.data.buildId !== identity.buildId ||
		parsed.data.appAsarSha256 !== identity.appAsarSha256
	)
		return "A different Quarterdeck app is already running for this state home. Quit it, then run quarterdeck --desktop again to open the selected npm installation.";
	return null;
}

/** Retains one pending open intent until the existing renderer's runtime admission is ready. */
export class DesktopLaunchRequests {
	private pending: DesktopLaunchRequest | null = null;

	constructor(
		private readonly identity: DesktopLaunchIdentity | null,
		private readonly openProject: (path: string) => boolean | "unsupported",
		private readonly onRefusal?: (message: string) => void,
	) {}

	accept(request: DesktopLaunchRequest): string | null {
		const refusal = desktopLaunchRefusal(request, this.identity);
		if (refusal) return refusal;
		if (request.projectPath !== undefined) this.pending = request;
		this.deliver();
		return null;
	}

	deliver(): void {
		const request = this.pending;
		if (request?.projectPath === undefined) return;
		const outcome = this.openProject(request.projectPath);
		if (outcome === false) return;
		this.pending = null;
		if (outcome === "unsupported")
			this.onRefusal?.(
				"The connected Quarterdeck runtime does not support npm project handoff. Stop that runtime, then run quarterdeck --desktop again to use the selected app's bundled runtime, or open the project from the app's project picker.",
			);
	}
}
