import { z } from "zod";
import { desktopInstallationOwnerSchema } from "../shared/desktop-installation-contract.js";

export const managedDesktopInstallationReceiptFilename = "managed-installation.json";
export const desktopApplicationBundleId = "io.github.dankhole.quarterdeck";
export const desktopLaunchProtocolVersion = 1;
export const desktopVersionPattern =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*)?$/u;
export const desktopSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const desktopVersionSchema = z.string().max(96).regex(desktopVersionPattern);
export const desktopArchitectureSchema = z.enum(["arm64", "x64"]);
export const desktopDistributionModeSchema = z.enum(["local", "ad-hoc", "signed", "windows-unsigned"]);
export type DesktopDistributionMode = z.infer<typeof desktopDistributionModeSchema>;

export const legacyManagedDesktopInstallationReceiptSchema = z
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

export const managedDesktopInstallationReceiptSchema = z
	.strictObject({
		schemaVersion: z.literal(2),
		managedBy: z.literal("quarterdeck-npm"),
		installId: z.uuid(),
		version: desktopVersionSchema,
		arch: desktopArchitectureSchema,
		source: z.enum(["release", "local"]),
		// Legacy receipts omit this field; release receipts were exclusively Developer ID signed.
		distributionMode: desktopDistributionModeSchema.optional(),
		appPath: z.string().min(1).max(4096),
		bundleId: z.literal(desktopApplicationBundleId),
		buildId: z.uuid(),
		appAsarSha256: desktopSha256Schema,
		appTreeSha256: desktopSha256Schema,
		desktopLaunchProtocolVersion: z.literal(desktopLaunchProtocolVersion),
		updatesEnabled: z.literal(false),
		owner: desktopInstallationOwnerSchema,
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
	.refine((receipt) => {
		const mode = desktopReceiptDistributionMode(receipt);
		if (receipt.source === "local")
			return (
				mode === "local" && !receipt.signing.verified && receipt.signing.teamId === null && receipt.release === null
			);
		return (
			receipt.release !== null &&
			(mode === "signed"
				? receipt.signing.verified && receipt.signing.teamId !== null
				: (mode === "ad-hoc" || mode === "windows-unsigned") &&
					!receipt.signing.verified &&
					receipt.signing.teamId === null)
		);
	}, "Installation origin, distribution mode, and Developer ID verification must agree.");

export function desktopReceiptDistributionMode(receipt: {
	source: "release" | "local";
	distributionMode?: DesktopDistributionMode;
}): DesktopDistributionMode {
	return receipt.distributionMode ?? (receipt.source === "release" ? "signed" : "local");
}

export type ManagedDesktopInstallationReceipt = z.infer<typeof managedDesktopInstallationReceiptSchema>;

export const managedDesktopSelectionSchema = z.strictObject({ schemaVersion: z.literal(1), installId: z.uuid() });
