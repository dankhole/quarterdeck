import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { DesktopInstallationError } from "./desktop-install/errors.js";
import {
	ensureDesktopInstallation,
	getDesktopInstallationStatus,
	resolveDesktopInstallationOwner,
} from "./desktop-install/index.js";
import { formatLegacyDesktopMigrationGuidance, inventoryLegacyDesktopInstallations } from "./desktop-install/legacy.js";
import { supportsDesktopHost } from "./launch-policy.js";
import type { DesktopInstallationOwner } from "./shared/desktop-installation-contract.js";

const INSTALL_TIMEOUT_MS = 180_000;
const WORKER_ARGUMENT = "--perform-global-install";

export interface NpmInstallContext {
	env: NodeJS.ProcessEnv;
	platform: string;
	arch: string;
	osRelease: string;
	uid: number | undefined;
	sourceCheckout: boolean;
}

export type NpmInstallPolicy = { action: "skip" } | { action: "install" } | { action: "reject"; message: string };

/** npm lifecycle intent is explicit; dependency installs and npm link never install a user app. */
export function resolveNpmInstallPolicy(context: NpmInstallContext): NpmInstallPolicy {
	const { env } = context;
	if (
		env.QUARTERDECK_INSTALL_MODE === "browser" ||
		env.npm_config_global !== "true" ||
		!["install", "update"].includes(env.npm_command ?? "") ||
		env.npm_lifecycle_event !== "postinstall" ||
		(env.CI !== undefined && !["", "0", "false"].includes(env.CI.toLowerCase())) ||
		context.sourceCheckout ||
		!supportsDesktopHost(context)
	) {
		return { action: "skip" };
	}
	if (
		context.uid === undefined ||
		context.uid === 0 ||
		env.SUDO_USER ||
		env.SUDO_UID ||
		!env.HOME ||
		!isAbsolute(env.HOME)
	) {
		return {
			action: "reject",
			message:
				"Desktop installation requires an unambiguous non-root user. Configure a user-owned npm prefix and install without sudo, or set QUARTERDECK_INSTALL_MODE=browser.",
		};
	}
	return { action: "install" };
}

export function npmInstallRecoveryMessage(version: string, reason: string): string {
	return `${reason}\nRetry: npm install -g quarterdeck@${version} --foreground-scripts\nIf the CLI remains available: quarterdeck desktop install\nFor an owning-prefix conflict, first install with QUARTERDECK_INSTALL_MODE=browser, then use that prefix's CLI with desktop install --replace-owner.`;
}

export async function installNpmDesktopPair(version: string, owner: DesktopInstallationOwner): Promise<void> {
	const installation = await ensureDesktopInstallation({ version, owner });
	if (installation.cleanupPending) {
		const status = await getDesktopInstallationStatus({ owner });
		if (status.state !== "ready" || status.pending)
			throw new DesktopInstallationError(
				"incomplete_installation",
				`The npm-managed app installation requires recovery: ${status.message}`,
			);
		console.warn(
			`[quarterdeck-install] The app pair is ready, but installer cleanup did not finish. Run quarterdeck desktop status for current readiness and inspect retained installer files under ${JSON.stringify(dirname(installation.receiptPath))}; leave uncertain files in place.`,
		);
	}
	for (const line of formatLegacyDesktopMigrationGuidance(await inventoryLegacyDesktopInstallations()))
		console.log(line);
}

async function run(): Promise<void> {
	const entrypoint = fileURLToPath(import.meta.url);
	const packageRoot = resolve(dirname(entrypoint), "..");
	const policy = resolveNpmInstallPolicy({
		env: process.env,
		platform: process.platform,
		arch: process.arch,
		osRelease: release(),
		uid: process.getuid?.(),
		sourceCheckout: existsSync(join(packageRoot, ".git")),
	});
	if (policy.action === "skip") return;
	if (policy.action === "reject") throw new Error(policy.message);
	if (process.argv[2] !== WORKER_ARGUMENT) {
		// A separate process bounds the entire noninteractive hook, including filesystem and OS tools.
		// An interrupted transaction is retained for the shared installer's next explicit repair.
		const result = spawnSync(process.execPath, [entrypoint, WORKER_ARGUMENT], {
			env: process.env,
			stdio: ["ignore", "inherit", "inherit"],
			timeout: INSTALL_TIMEOUT_MS,
			killSignal: "SIGTERM",
			windowsHide: true,
		});
		if (result.error)
			throw new Error(
				`Desktop installation did not complete within its bounded npm lifecycle: ${result.error.message}`,
			);
		if (result.status !== 0)
			throw new Error("Desktop installation is incomplete; npm may not have retained the command.");
		return;
	}
	const prefix = process.env.npm_config_prefix;
	if (!prefix || !isAbsolute(prefix))
		throw new Error("npm did not provide an absolute global prefix; desktop ownership cannot be established.");
	const owner = await resolveDesktopInstallationOwner({
		packageRoot,
		packageSlot: join(prefix, "lib", "node_modules", "quarterdeck"),
		prefix,
		kind: "npm",
	});
	await installNpmDesktopPair(packageJson.version, owner);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	void run().catch((error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`[quarterdeck-install] ${npmInstallRecoveryMessage(packageJson.version, reason)}`);
		process.exitCode = 1;
	});
}
