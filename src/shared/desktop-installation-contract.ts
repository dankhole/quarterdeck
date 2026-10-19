import { z } from "zod";

export const desktopBuildIdentitySchema = z.strictObject({
	schemaVersion: z.literal(1),
	version: z.string().min(1).max(96),
	buildId: z.uuid(),
	sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
	sourceDirty: z.boolean(),
});

export const desktopInstallationOwnerSchema = z.strictObject({
	kind: z.enum(["npm", "link"]),
	packageSlot: z.string().startsWith("/").max(4096),
	packageRoot: z.string().startsWith("/").max(4096),
	prefix: z.string().startsWith("/").max(4096),
	identity: desktopBuildIdentitySchema,
});

export type DesktopBuildIdentity = z.infer<typeof desktopBuildIdentitySchema>;
export type DesktopInstallationOwner = z.infer<typeof desktopInstallationOwnerSchema>;

/** Public releases have independent architecture builds; local pairs share one exact build. */
export function desktopBuildsMatch(
	owner: DesktopInstallationOwner,
	app: Pick<DesktopBuildIdentity, "version" | "buildId" | "sourceSha" | "sourceDirty">,
	source: "local" | "release",
): boolean {
	return (
		owner.identity.version === app.version &&
		owner.identity.sourceSha === app.sourceSha &&
		(source === "local" || owner.kind === "link"
			? owner.identity.buildId === app.buildId
			: !owner.identity.sourceDirty && !app.sourceDirty)
	);
}
