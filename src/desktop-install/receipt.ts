import { z } from "zod";

export const managedDesktopInstallationReceiptFilename = "managed-installation.json";
export const desktopApplicationBundleId = "io.github.dankhole.quarterdeck";
export const desktopLaunchProtocolVersion = 1;
export const desktopVersionPattern =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*)?$/u;
export const desktopSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const desktopVersionSchema = z.string().max(96).regex(desktopVersionPattern);
export const desktopArchitectureSchema = z.enum(["arm64", "x64"]);

export const managedDesktopInstallationReceiptSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		managedBy: z.literal("quarterdeck-npm"),
		installId: z.uuid(),
		version: desktopVersionSchema,
		arch: desktopArchitectureSchema,
		source: z.enum(["release", "local"]),
		appPath: z.literal("Quarterdeck.app"),
		bundleId: z.literal(desktopApplicationBundleId),
		buildId: z.uuid(),
		appAsarSha256: desktopSha256Schema,
		appTreeSha256: desktopSha256Schema,
		desktopLaunchProtocolVersion: z.literal(desktopLaunchProtocolVersion),
		updatesEnabled: z.literal(false),
		signing: z.strictObject({
			verified: z.boolean(),
			teamId: z
				.string()
				.regex(/^[A-Z0-9]{10}$/u)
				.nullable(),
		}),
		release: z
			.strictObject({
				manifestSha256: desktopSha256Schema,
				containerName: z.string().max(200),
				containerSha256: desktopSha256Schema,
				sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
			})
			.nullable(),
	})
	.refine(
		(receipt) =>
			receipt.source === "release"
				? receipt.signing.verified && receipt.signing.teamId !== null && receipt.release !== null
				: !receipt.signing.verified && receipt.signing.teamId === null && receipt.release === null,
		"Installation origin and verified signing metadata must agree.",
	);

export type ManagedDesktopInstallationReceipt = z.infer<typeof managedDesktopInstallationReceiptSchema>;

export const managedDesktopSelectionSchema = z.strictObject({ schemaVersion: z.literal(1), installId: z.uuid() });
