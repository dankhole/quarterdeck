import {
	applyDesktopExecutableDirectories,
	type DesktopEnvironmentPreferences,
	readDesktopEnvironmentPreferences,
} from "./environment-preferences.js";
import {
	createDesktopLaunchEnvironmentResolver,
	type DesktopLaunchEnvironmentOptions,
	type DesktopLaunchEnvironmentResult,
} from "./launch-environment.js";

export type DesktopRuntimeEnvironmentResult = DesktopLaunchEnvironmentResult & {
	preferences: DesktopEnvironmentPreferences;
};

/** Startup and guarded refresh share the same preference-to-helper composition. */
export async function resolveDesktopRuntimeEnvironment(
	options: Omit<DesktopLaunchEnvironmentOptions, "mode"> & { userDataPath: string },
): Promise<DesktopRuntimeEnvironmentResult> {
	const { userDataPath, ...launchOptions } = options;
	const preferences = await readDesktopEnvironmentPreferences(userDataPath);
	const result = await createDesktopLaunchEnvironmentResolver({
		...launchOptions,
		mode: preferences.importLoginShellEnvironment ? "login-shell" : "auto",
	})();
	return {
		...result,
		preferences,
		environment: applyDesktopExecutableDirectories(
			result.environment,
			options.nodePath,
			preferences.extraExecutableDirectories,
		),
	};
}
