import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const QUARTERDECK_PI_HOOK_COMMAND_ENV = "QUARTERDECK_PI_HOOK_COMMAND_JSON";

const PI_LIFECYCLE_EXTENSION_ASSET_FILENAME = "pi-lifecycle-extension.runtime.js";
const PI_LIFECYCLE_EXTENSION_HOOK_COMMAND_ENV_PLACEHOLDER = "__QUARTERDECK_PI_HOOK_COMMAND_ENV__";

let cachedPiLifecycleExtensionSource: string | null = null;

export function buildPiLifecycleExtensionSource(): string {
	if (cachedPiLifecycleExtensionSource !== null) {
		return cachedPiLifecycleExtensionSource;
	}

	const source = readPiLifecycleExtensionAsset();
	const placeholderCount = source.split(PI_LIFECYCLE_EXTENSION_HOOK_COMMAND_ENV_PLACEHOLDER).length - 1;
	if (placeholderCount !== 1) {
		throw new Error(
			`Pi lifecycle extension asset must contain exactly one ${PI_LIFECYCLE_EXTENSION_HOOK_COMMAND_ENV_PLACEHOLDER} placeholder.`,
		);
	}

	cachedPiLifecycleExtensionSource = source.replace(
		PI_LIFECYCLE_EXTENSION_HOOK_COMMAND_ENV_PLACEHOLDER,
		QUARTERDECK_PI_HOOK_COMMAND_ENV,
	);
	return cachedPiLifecycleExtensionSource;
}

function readPiLifecycleExtensionAsset(): string {
	return readFileSync(resolvePiLifecycleExtensionAssetPath(), "utf8");
}

function resolvePiLifecycleExtensionAssetPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// Source/dev/test execution: src/terminal/pi-lifecycle-extension.runtime.js
		join(moduleDir, PI_LIFECYCLE_EXTENSION_ASSET_FILENAME),
		// Bundled package execution: dist/cli.js or dist/index.js plus copied dist/terminal asset.
		join(moduleDir, "terminal", PI_LIFECYCLE_EXTENSION_ASSET_FILENAME),
	];
	const assetPath = candidates.find((candidate) => existsSync(candidate));
	if (assetPath) {
		return assetPath;
	}
	throw new Error(`Could not find Pi lifecycle extension asset. Checked: ${candidates.join(", ")}`);
}
