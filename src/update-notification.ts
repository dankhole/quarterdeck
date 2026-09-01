import updateNotifier, { type NotifyOptions, type Settings as UpdateNotifierSettings } from "update-notifier";
import packageJson from "../package.json" with { type: "json" };

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

interface Notifier {
	notify(options?: NotifyOptions): unknown;
}

type CreateNotifier = (settings?: UpdateNotifierSettings) => Notifier;

interface UpdateNotificationOptions {
	isInteractive?: boolean;
	createNotifier?: CreateNotifier;
}

/**
 * Show a cached npm update notice without delaying CLI startup.
 *
 * update-notifier owns the one-day check policy and performs due registry
 * lookups in an unref'd child process. Failures must never prevent Quarterdeck
 * from starting.
 */
export function notifyAboutAvailableUpdate(options: UpdateNotificationOptions = {}): void {
	if (!(options.isInteractive ?? process.stdout.isTTY)) {
		return;
	}

	try {
		const notifier = (options.createNotifier ?? updateNotifier)({
			pkg: {
				name: packageJson.name,
				version: packageJson.version,
			},
			distTag: "latest",
			updateCheckInterval: ONE_DAY_MS,
		});
		notifier.notify({
			defer: false,
			message:
				"Quarterdeck {latestVersion} is available (current: {currentVersion}).\nRun npm install --global quarterdeck@latest to update.",
		});
	} catch {
		// Update discovery is optional and must not affect startup correctness.
	}
}
