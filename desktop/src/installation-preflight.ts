import {
	type DesktopInstallation,
	DesktopInstallationError,
	validateDesktopInstallation,
	validateDesktopNativeAdmission,
} from "../../src/desktop-install/index.js";

export type DesktopInstallationAdmission = Awaited<ReturnType<typeof validateDesktopNativeAdmission>>;

export interface DesktopInstallationPreflight {
	installation: DesktopInstallation | null;
	admission: DesktopInstallationAdmission;
}

interface DesktopInstallationPreflightInput {
	appPath: string;
	version: string;
	synthetic: boolean;
}

interface DesktopInstallationPreflightServices {
	validateAdmission: typeof validateDesktopNativeAdmission;
	validateInstallation: typeof validateDesktopInstallation;
}

/** Dock startup resolves its recorded package owner directly, before reading or starting the bundled runtime. */
export async function preflightDesktopInstallation(
	input: DesktopInstallationPreflightInput,
	services: DesktopInstallationPreflightServices = {
		validateAdmission: validateDesktopNativeAdmission,
		validateInstallation: validateDesktopInstallation,
	},
): Promise<DesktopInstallationPreflight> {
	const admission = await services.validateAdmission({ appPath: input.appPath, synthetic: input.synthetic });
	// The admission validator alone decides whether a noncanonical synthetic lab bundle may bypass installation.
	if (admission === null) {
		if (input.synthetic) return { installation: null, admission: null };
		throw new DesktopInstallationError(
			"incomplete_installation",
			"Quarterdeck did not obtain installation admission. Quit the app, then run quarterdeck desktop install.",
		);
	}
	const installation = await services.validateInstallation({ appPath: input.appPath, version: input.version });
	return { installation, admission };
}
