import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { runtimeProcessIdentitySchema } from "../core/api/runtime-management.js";
import {
	inspectRuntimeProcess,
	readRuntimeHostIdentity,
	readRuntimeProcessIdentity,
} from "../server/runtime-process-identity.js";
import {
	type DesktopInstallationOwner,
	desktopInstallationOwnerSchema,
} from "../shared/desktop-installation-contract.js";
import { DesktopInstallationError } from "./errors.js";
import { readDesktopJson } from "./files.js";
import { desktopPathExists, writeDesktopJson } from "./transaction-files.js";

const stageSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: z.uuid(),
	appPath: z.string(),
	owner: desktopInstallationOwnerSchema,
	host: z.string(),
	process: runtimeProcessIdentitySchema,
});

export async function writeDesktopStageOwner(
	stage: string,
	id: string,
	appPath: string,
	owner: DesktopInstallationOwner,
	identity?: { host: string; process: { pid: number; creationIdentity: string } },
): Promise<void> {
	const processIdentity = identity?.process ?? (await readRuntimeProcessIdentity(process.pid));
	if (!processIdentity)
		throw new DesktopInstallationError(
			"incomplete_installation",
			"Could not establish the installer process identity.",
		);
	await writeDesktopJson(join(stage, "stage-owner.json"), {
		schemaVersion: 1,
		id,
		appPath,
		owner,
		host: identity?.host ?? (await readRuntimeHostIdentity()),
		process: processIdentity,
	});
}

/** Only exact owned stages whose process is proven dead are reclaimed; age never grants ownership. */
export async function reapDesktopStages(appPath: string, activeStage: string | null): Promise<number> {
	const parent = dirname(appPath);
	let retained = 0;
	for (const name of await readdir(parent)) {
		if (!/^\.Quarterdeck-install-[a-f0-9-]{36}$/u.test(name)) continue;
		const stage = join(parent, name);
		if (stage === activeStage) continue;
		const info = await lstat(stage);
		if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) {
			retained++;
			continue;
		}
		const names = await readdir(stage);
		if (names.length === 0) {
			retained++;
			continue;
		}
		try {
			const parsed = stageSchema.safeParse(await readDesktopJson(join(stage, "stage-owner.json")));
			if (
				!parsed.success ||
				name !== `.Quarterdeck-install-${parsed.data.id}` ||
				parsed.data.appPath !== appPath ||
				parsed.data.host !== (await readRuntimeHostIdentity()) ||
				(await inspectRuntimeProcess(parsed.data.process)) !== "dead"
			) {
				retained++;
				continue;
			}
			if (await desktopPathExists(join(stage, "backup.app"))) {
				retained++;
				continue;
			}
			const mount = join(stage, "mount");
			if ((await desktopPathExists(mount)) && (await lstat(mount)).dev !== info.dev) {
				retained++;
				continue;
			}
			await rm(stage, { recursive: true });
		} catch {
			retained++;
		}
	}
	return retained;
}
