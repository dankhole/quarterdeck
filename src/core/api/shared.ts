import { z } from "zod";
import { runtimeHostIntegrationActionResponseSchema, runtimeOpenTargetIdSchema } from "./host-integrations.js";

export const runtimeWorkdirFileStatusSchema = z.enum([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"untracked",
	"conflicted",
	"unknown",
]);
export type RuntimeWorkdirFileStatus = z.infer<typeof runtimeWorkdirFileStatusSchema>;

export const runtimeAgentIdSchema = z.enum(["claude", "codex", "pi"]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;

export const runtimeMaintainedAgentIdSchema = z.enum(["claude", "codex", "pi"]);
export type RuntimeMaintainedAgentId = z.infer<typeof runtimeMaintainedAgentIdSchema>;

export const runtimeBoardColumnIdSchema = z.enum(["in_progress", "review", "trash"]);
export type RuntimeBoardColumnId = z.infer<typeof runtimeBoardColumnIdSchema>;

/** Inline upload: base64 bytes travel with new attachments, launch input, and terminal paste. */
export const runtimeTaskImageSchema = z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
	name: z.string().optional(),
});
export type RuntimeTaskImage = z.infer<typeof runtimeTaskImageSchema>;

export const runtimeTaskImageSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const runtimeTaskImageRefShape = {
	id: z.string(),
	name: z.string().optional(),
	mimeType: z.string(),
	sha256: runtimeTaskImageSha256Schema,
	byteLength: z.number().int().nonnegative(),
};

/**
 * Durable attachment: bytes live in the owning project's content-addressed
 * image store. Strict for writes, so an object that also carries bytes is
 * treated as an upload rather than silently losing them.
 */
export const runtimeTaskImageRefSchema = z.object(runtimeTaskImageRefShape).strict();
export type RuntimeTaskImageRef = z.infer<typeof runtimeTaskImageRefSchema>;

/**
 * Command attachment: a stored reference, or an inline upload the runtime
 * externalizes under the project lock before the board commits.
 */
export const runtimeTaskImageInputSchema = z.union([runtimeTaskImageRefSchema, runtimeTaskImageSchema]);
export type RuntimeTaskImageInput = z.infer<typeof runtimeTaskImageInputSchema>;

/**
 * Card attachment as read from boards and published state. Inline bytes win;
 * references tolerate (and drop) fields added by a newer runtime.
 */
export const runtimeTaskImageReadSchema = z.union([runtimeTaskImageSchema, z.object(runtimeTaskImageRefShape)]);

export const runtimeTaskImageReadRequestSchema = z.object({ sha256: runtimeTaskImageSha256Schema }).strict();
export type RuntimeTaskImageReadRequest = z.infer<typeof runtimeTaskImageReadRequestSchema>;

/** Base64 bytes for one stored attachment in the requesting project, or null when absent. */
export const runtimeTaskImageReadResponseSchema = z
	.object({
		sha256: runtimeTaskImageSha256Schema,
		data: z.string(),
	})
	.nullable();
export type RuntimeTaskImageReadResponse = z.infer<typeof runtimeTaskImageReadResponseSchema>;

export function isRuntimeTaskImageRef(image: RuntimeTaskImageInput): image is RuntimeTaskImageRef {
	return "sha256" in image;
}

/** Decoded byte length of inline base64 data without decoding it. */
export function getRuntimeTaskImageByteLength(image: RuntimeTaskImageInput): number {
	if (isRuntimeTaskImageRef(image)) return image.byteLength;
	const data = image.data.replace(/\s/g, "");
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Attachment identity for idempotency checks. An inline upload and a stored
 * reference to the same attachment compare equal by identity and byte length:
 * hashing is unavailable to the synchronous browser overlay, and attachment IDs
 * are generated per upload.
 */
export function areRuntimeTaskImagesEqual(
	first: readonly RuntimeTaskImageInput[] | undefined,
	second: readonly RuntimeTaskImageInput[] | undefined,
): boolean {
	const left = first?.length ? first : undefined;
	const right = second?.length ? second : undefined;
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((image, index) => {
		const candidate = right[index];
		if (
			candidate === undefined ||
			image.id !== candidate.id ||
			image.mimeType !== candidate.mimeType ||
			image.name !== candidate.name
		) {
			return false;
		}
		if (isRuntimeTaskImageRef(image) && isRuntimeTaskImageRef(candidate)) {
			return image.sha256 === candidate.sha256 && image.byteLength === candidate.byteLength;
		}
		if (!isRuntimeTaskImageRef(image) && !isRuntimeTaskImageRef(candidate)) {
			return image.data === candidate.data;
		}
		return getRuntimeTaskImageByteLength(image) === getRuntimeTaskImageByteLength(candidate);
	});
}

export const runtimeSlashCommandSchema = z.object({
	name: z.string(),
	instructions: z.string(),
	description: z.string().optional(),
});
export type RuntimeSlashCommand = z.infer<typeof runtimeSlashCommandSchema>;

export const runtimeSlashCommandsResponseSchema = z.object({
	commands: z.array(runtimeSlashCommandSchema),
});
export type RuntimeSlashCommandsResponse = z.infer<typeof runtimeSlashCommandsResponseSchema>;

/** Project-level terminal command shortcuts (top bar). For agent prompt shortcuts, see promptShortcutSchema. */
export const runtimeProjectShortcutSchema = z.object({
	label: z.string(),
	command: z.string(),
	icon: z.string().optional(),
});
export type RuntimeProjectShortcut = z.infer<typeof runtimeProjectShortcutSchema>;

/** Global agent prompt injection shortcuts (sidebar review cards). For project terminal commands, see runtimeProjectShortcutSchema. */
export const promptShortcutSchema = z.object({
	label: z.string().min(1).max(30),
	prompt: z.string().min(1),
});
export type PromptShortcut = z.infer<typeof promptShortcutSchema>;

export const runtimeOpenFileRequestSchema = z.object({
	filePath: z.string(),
});
export type RuntimeOpenFileRequest = z.infer<typeof runtimeOpenFileRequestSchema>;

export const runtimeOpenFileResponseSchema = runtimeHostIntegrationActionResponseSchema;
export type RuntimeOpenFileResponse = z.infer<typeof runtimeOpenFileResponseSchema>;

export const runtimeOpenProjectRequestSchema = z
	.object({
		targetId: runtimeOpenTargetIdSchema,
	})
	.strict();
export type RuntimeOpenProjectRequest = z.infer<typeof runtimeOpenProjectRequestSchema>;

export const runtimeOpenProjectResponseSchema = runtimeHostIntegrationActionResponseSchema;
export type RuntimeOpenProjectResponse = z.infer<typeof runtimeOpenProjectResponseSchema>;

export const runtimeTaskWorktreeInfoRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeTaskWorktreeInfoRequest = z.infer<typeof runtimeTaskWorktreeInfoRequestSchema>;
