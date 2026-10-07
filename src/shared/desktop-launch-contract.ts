import { z } from "zod";

export const DESKTOP_LAUNCH_ARGUMENT = "--quarterdeck-launch";
export const DESKTOP_LAUNCH_MAX_BYTES = 16_384;
export const DESKTOP_LAUNCH_PROTOCOL_VERSION = 1;

/** A native project-open intent, never executable arguments or environment overrides. */
export const desktopLaunchPathSchema = z
	.string()
	.min(1)
	.max(4096)
	.regex(/^\/[^\p{Cc}]*$/u);
export const desktopLaunchAppIdentitySchema = z.strictObject({
	version: z
		.string()
		.min(1)
		.max(100)
		.regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u),
	appPath: desktopLaunchPathSchema,
	arch: z.enum(["arm64", "x64"]),
	buildId: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[a-zA-Z0-9._:-]+$/u),
	appAsarSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type DesktopLaunchAppIdentity = z.infer<typeof desktopLaunchAppIdentitySchema>;
export const desktopLaunchRequestSchema = desktopLaunchAppIdentitySchema.extend({
	schemaVersion: z.literal(DESKTOP_LAUNCH_PROTOCOL_VERSION),
	stateHome: desktopLaunchPathSchema,
	projectPath: desktopLaunchPathSchema.optional(),
});
export type DesktopLaunchRequest = z.infer<typeof desktopLaunchRequestSchema>;

export function serializeDesktopLaunchRequest(request: DesktopLaunchRequest): string {
	const encoded = JSON.stringify(desktopLaunchRequestSchema.parse(request));
	if (new TextEncoder().encode(encoded).byteLength > DESKTOP_LAUNCH_MAX_BYTES)
		throw new Error("Quarterdeck desktop launch request is too large.");
	return encoded;
}

/** Electron may add its own arguments; only one exact bounded launch option is accepted. */
export function readDesktopLaunchRequest(args: readonly string[]): DesktopLaunchRequest | null {
	const positions = args.flatMap((argument, index) => (argument === DESKTOP_LAUNCH_ARGUMENT ? [index] : []));
	const position = positions[0];
	if (position === undefined) return null;
	const encoded = args[position + 1];
	if (
		positions.length !== 1 ||
		encoded === undefined ||
		new TextEncoder().encode(encoded).byteLength > DESKTOP_LAUNCH_MAX_BYTES
	)
		throw new Error("Quarterdeck desktop launch request is invalid. Run quarterdeck --desktop again.");
	try {
		return desktopLaunchRequestSchema.parse(JSON.parse(encoded));
	} catch {
		throw new Error("Quarterdeck desktop launch request is invalid. Run quarterdeck --desktop again.");
	}
}
