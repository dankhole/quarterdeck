import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertStandaloneBuildIsSafe } from "./managed-installation-guard.mjs";

const scriptPath = fileURLToPath(import.meta.url);

export async function cleanCheckout(checkoutRoot, options = {}) {
	await assertStandaloneBuildIsSafe(checkoutRoot, {
		...options.managedInstallation,
		pairedDesktopInstall: options.pairedDesktopInstall,
	});
	await Promise.all([
		rm(join(checkoutRoot, "dist"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
		rm(join(checkoutRoot, "coverage"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	]);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
	await cleanCheckout(resolve(dirname(scriptPath), ".."));
}
