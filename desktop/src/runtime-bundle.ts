import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_LAUNCH_PROTOCOL_VERSION } from "../../src/shared/desktop-launch-contract.js";

export interface RuntimeBundle {
	root: string;
	nodePath: string;
	cliPath: string;
	version: string;
	buildId: string;
	sourceSha: string;
	arch: string;
}

export function readRuntimeBundle(root: string, expectedVersion: string, architecture: string): RuntimeBundle {
	const canonicalRoot = realpathSync(root);
	const manifestPath = join(canonicalRoot, "bundle-manifest.json");
	if (statSync(manifestPath).size > 16_384) throw new Error("Invalid runtime bundle manifest.");
	const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
		throw new Error("Invalid runtime bundle manifest.");
	const record = manifest as Record<string, unknown>;
	if (
		record.desktopLaunchProtocolVersion !== DESKTOP_LAUNCH_PROTOCOL_VERSION ||
		record.version !== expectedVersion ||
		record.arch !== architecture ||
		record.platform !== "darwin" ||
		typeof record.buildId !== "string" ||
		!record.buildId ||
		typeof record.sourceSha !== "string" ||
		!/^[a-f0-9]{40}$/u.test(record.sourceSha)
	) {
		throw new Error("Runtime bundle identity does not match the desktop application.");
	}
	const nodePath = join(canonicalRoot, "bin", "node");
	const cliPath = join(canonicalRoot, "dist", "cli.js");
	if (!statSync(nodePath).isFile() || !statSync(cliPath).isFile())
		throw new Error("The bundled runtime is incomplete.");
	return {
		root: canonicalRoot,
		nodePath,
		cliPath,
		version: expectedVersion,
		buildId: record.buildId,
		sourceSha: record.sourceSha,
		arch: architecture,
	};
}
