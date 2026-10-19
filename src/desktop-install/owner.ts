import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DesktopInstallationOwner, desktopBuildIdentitySchema } from "../shared/desktop-installation-contract.js";
import { DesktopInstallationError } from "./errors.js";
import { readDesktopJson } from "./files.js";

export interface ResolveDesktopInstallationOwnerOptions {
	packageRoot?: string;
	packageSlot?: string;
	prefix?: string;
	kind?: "npm" | "link";
}

export async function resolveDesktopInstallationOwner(
	options: ResolveDesktopInstallationOwnerOptions = {},
): Promise<DesktopInstallationOwner> {
	let packageRoot = options.packageRoot;
	if (!packageRoot) {
		let candidate = dirname(fileURLToPath(import.meta.url));
		for (let depth = 0; depth < 4; depth++) {
			try {
				const metadata = await readDesktopJson(join(candidate, "package.json"), 64 * 1024);
				if (
					typeof metadata === "object" &&
					metadata !== null &&
					"name" in metadata &&
					metadata.name === "quarterdeck"
				) {
					packageRoot = candidate;
					break;
				}
			} catch {
				/* Source modules and bundled entrypoints have different depths. */
			}
			candidate = dirname(candidate);
		}
	}
	if (!packageRoot)
		throw new DesktopInstallationError("installation_changed", "Could not locate this CLI's package root.");
	packageRoot = await realpath(packageRoot);
	let invokingPrefix: string | undefined;
	if (process.argv[1] && dirname(process.argv[1]).endsWith("/bin")) {
		const candidate = resolve(dirname(process.argv[1]), "..");
		try {
			if ((await realpath(join(candidate, "lib/node_modules/quarterdeck"))) === packageRoot)
				invokingPrefix = candidate;
		} catch {
			/* An ordinary source invocation has no global slot. */
		}
	}
	const installedSuffix = "/lib/node_modules/quarterdeck";
	const installedPrefix = packageRoot.endsWith(installedSuffix)
		? packageRoot.slice(0, -installedSuffix.length)
		: undefined;
	const requestedPrefix = options.prefix ?? invokingPrefix ?? installedPrefix ?? process.env.npm_config_prefix;
	if (!requestedPrefix)
		throw new DesktopInstallationError(
			"owner_conflict",
			"This source CLI has no unambiguous global npm slot. Run npm run link, or invoke the intended global quarterdeck executable.",
		);
	const prefix = resolve(requestedPrefix);
	const packageSlot = resolve(options.packageSlot ?? join(prefix, "lib/node_modules/quarterdeck"));
	if (
		!isAbsolute(packageSlot) ||
		packageSlot !== join(prefix, "lib/node_modules/quarterdeck") ||
		(await realpath(packageSlot)) !== packageRoot
	)
		throw new DesktopInstallationError(
			"owner_conflict",
			"This CLI does not occupy the recorded global npm package slot. Run npm run link, or reinstall quarterdeck globally with the intended Node prefix.",
		);
	const identity = desktopBuildIdentitySchema.safeParse(
		await readDesktopJson(join(packageRoot, "dist/build-manifest.json"), 4096),
	);
	if (!identity.success)
		throw new DesktopInstallationError(
			"installation_changed",
			"The npm build identity is missing or invalid. Rebuild and run npm run link, or reinstall quarterdeck globally.",
		);
	const metadata = await readDesktopJson(join(packageRoot, "package.json"), 64 * 1024);
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		!("name" in metadata) ||
		!("version" in metadata) ||
		metadata.name !== "quarterdeck" ||
		metadata.version !== identity.data.version
	)
		throw new DesktopInstallationError(
			"installation_changed",
			"The npm package name or version differs from its build identity.",
		);
	return {
		kind: options.kind ?? ((await lstat(packageSlot)).isSymbolicLink() ? "link" : "npm"),
		packageSlot,
		packageRoot,
		prefix,
		identity: identity.data,
	};
}

export async function validateDesktopInstallationOwner(owner: DesktopInstallationOwner): Promise<void> {
	try {
		const current = await resolveDesktopInstallationOwner(owner);
		if (
			!sameDesktopOwner(current, owner) ||
			current.identity.schemaVersion !== owner.identity.schemaVersion ||
			current.identity.version !== owner.identity.version ||
			current.identity.buildId !== owner.identity.buildId ||
			current.identity.sourceSha !== owner.identity.sourceSha ||
			current.identity.sourceDirty !== owner.identity.sourceDirty
		)
			throw new Error("Owner changed");
	} catch {
		throw new DesktopInstallationError(
			"installation_changed",
			`The owning npm CLI is missing or changed. Repair it with QUARTERDECK_INSTALL_MODE=desktop npm install --global --prefix ${JSON.stringify(owner.prefix)} quarterdeck, or run npm run link in the owning checkout.`,
		);
	}
}

export function sameDesktopOwner(left: DesktopInstallationOwner, right: DesktopInstallationOwner): boolean {
	return (
		left.kind === right.kind &&
		left.packageSlot === right.packageSlot &&
		left.packageRoot === right.packageRoot &&
		left.prefix === right.prefix
	);
}
