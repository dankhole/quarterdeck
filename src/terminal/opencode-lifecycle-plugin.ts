import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const QUARTERDECK_OPENCODE_HOOK_COMMAND_ENV = "QUARTERDECK_OPENCODE_HOOK_COMMAND_JSON";

const OPENCODE_LIFECYCLE_PLUGIN_ASSET_FILENAME = "opencode-lifecycle-plugin.runtime.js";
const OPENCODE_LIFECYCLE_PLUGIN_HOOK_COMMAND_ENV_PLACEHOLDER = "__QUARTERDECK_OPENCODE_HOOK_COMMAND_ENV__";

let cachedOpencodeLifecyclePluginSource: string | null = null;

export function buildOpencodeLifecyclePluginSource(): string {
	if (cachedOpencodeLifecyclePluginSource !== null) {
		return cachedOpencodeLifecyclePluginSource;
	}

	const source = readOpencodeLifecyclePluginAsset();
	const hookCommandPlaceholderCount = source.split(OPENCODE_LIFECYCLE_PLUGIN_HOOK_COMMAND_ENV_PLACEHOLDER).length - 1;
	if (hookCommandPlaceholderCount !== 1) {
		throw new Error(
			`opencode lifecycle plugin asset must contain exactly one ${OPENCODE_LIFECYCLE_PLUGIN_HOOK_COMMAND_ENV_PLACEHOLDER} placeholder.`,
		);
	}
	cachedOpencodeLifecyclePluginSource = source.replace(
		OPENCODE_LIFECYCLE_PLUGIN_HOOK_COMMAND_ENV_PLACEHOLDER,
		QUARTERDECK_OPENCODE_HOOK_COMMAND_ENV,
	);
	return cachedOpencodeLifecyclePluginSource;
}

export function getOpencodeLifecyclePluginFingerprint(): string {
	return createHash("sha256").update(buildOpencodeLifecyclePluginSource(), "utf8").digest("hex");
}

function readOpencodeLifecyclePluginAsset(): string {
	return readFileSync(resolveOpencodeLifecyclePluginAssetPath(), "utf8");
}

function resolveOpencodeLifecyclePluginAssetPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// Source/dev/test execution: src/terminal/opencode-lifecycle-plugin.runtime.js
		join(moduleDir, OPENCODE_LIFECYCLE_PLUGIN_ASSET_FILENAME),
		// Bundled package execution: dist/cli.js or dist/index.js plus copied dist/terminal asset.
		join(moduleDir, "terminal", OPENCODE_LIFECYCLE_PLUGIN_ASSET_FILENAME),
	];
	const assetPath = candidates.find((candidate) => existsSync(candidate));
	if (assetPath) {
		return assetPath;
	}
	throw new Error(`Could not find opencode lifecycle plugin asset. Checked: ${candidates.join(", ")}`);
}
