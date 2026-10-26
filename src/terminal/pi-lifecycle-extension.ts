import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const QUARTERDECK_PI_HOOK_COMMAND_ENV = "QUARTERDECK_PI_HOOK_COMMAND_JSON";
export const QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV = "QUARTERDECK_PI_WORKTREE_TRUST_SCOPE";
// Published only when the runtime's loopback hook HTTP channel is active (see
// `hook-http-channel.ts`); the extension POSTs best-effort activity hooks to
// this URL in-process instead of spawning `hooks notify`, mirroring Claude's
// `type: "http"` hooks. Reliable lifecycle hooks use the bundled shared client.
export const QUARTERDECK_PI_HOOK_HTTP_URL_ENV = "QUARTERDECK_PI_HOOK_HTTP_URL";

const PI_LIFECYCLE_EXTENSION_ASSET_FILENAME = "pi-lifecycle-extension.runtime.js";
const PI_LIFECYCLE_EXTENSION_HOOK_COMMAND_ENV_PLACEHOLDER = "__QUARTERDECK_PI_HOOK_COMMAND_ENV__";
const PI_LIFECYCLE_EXTENSION_HOOK_HTTP_URL_ENV_PLACEHOLDER = "__QUARTERDECK_PI_HOOK_HTTP_URL_ENV__";
const PI_LIFECYCLE_EXTENSION_WORKTREE_TRUST_SCOPE_ENV_PLACEHOLDER = "__QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV__";

let cachedPiLifecycleExtensionSource: string | null = null;

function requireExactlyOnePlaceholder(source: string, placeholder: string): void {
	const count = source.split(placeholder).length - 1;
	if (count !== 1) {
		throw new Error(`Pi lifecycle extension asset must contain exactly one ${placeholder} placeholder.`);
	}
}

export function buildPiLifecycleExtensionSource(): string {
	if (cachedPiLifecycleExtensionSource !== null) {
		return cachedPiLifecycleExtensionSource;
	}

	const source = readPiLifecycleExtensionAsset();
	requireExactlyOnePlaceholder(source, PI_LIFECYCLE_EXTENSION_HOOK_COMMAND_ENV_PLACEHOLDER);
	requireExactlyOnePlaceholder(source, PI_LIFECYCLE_EXTENSION_HOOK_HTTP_URL_ENV_PLACEHOLDER);
	requireExactlyOnePlaceholder(source, PI_LIFECYCLE_EXTENSION_WORKTREE_TRUST_SCOPE_ENV_PLACEHOLDER);
	// Production assets bundle these static imports. Source/dev execution uses
	// Pi's TypeScript-capable loader, with file URLs preserving Windows drives,
	// spaces and URL-reserved characters after the asset is copied for launch.
	const linkedSource = linkPiLifecycleExtensionImports(source, pathToFileURL(resolvePiLifecycleExtensionAssetPath()));
	cachedPiLifecycleExtensionSource = linkedSource
		.replace(PI_LIFECYCLE_EXTENSION_HOOK_COMMAND_ENV_PLACEHOLDER, QUARTERDECK_PI_HOOK_COMMAND_ENV)
		.replace(PI_LIFECYCLE_EXTENSION_HOOK_HTTP_URL_ENV_PLACEHOLDER, QUARTERDECK_PI_HOOK_HTTP_URL_ENV)
		.replace(PI_LIFECYCLE_EXTENSION_WORKTREE_TRUST_SCOPE_ENV_PLACEHOLDER, QUARTERDECK_PI_WORKTREE_TRUST_SCOPE_ENV);
	return cachedPiLifecycleExtensionSource;
}

export function linkPiLifecycleExtensionImports(source: string, assetUrl: URL): string {
	return source
		.replace(
			'from "../commands/hook-metadata.js"',
			`from ${JSON.stringify(new URL("../commands/hook-metadata.ts", assetUrl).href)}`,
		)
		.replace(
			'from "../hook-reliable-delivery.js"',
			`from ${JSON.stringify(new URL("../hook-reliable-delivery.ts", assetUrl).href)}`,
		)
		.replace(
			'from "../hook-delivery-order.js"',
			`from ${JSON.stringify(new URL("../hook-delivery-order.ts", assetUrl).href)}`,
		);
}

export function getPiLifecycleExtensionFingerprint(): string {
	return createHash("sha256").update(buildPiLifecycleExtensionSource(), "utf8").digest("hex");
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
