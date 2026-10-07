import { z } from "zod";
import type { FileEditorDraft, FileEditorScopeIdentity } from "./file-editor-cache";

export const FILE_EDITOR_RECOVERY_KEY = "quarterdeck.desktop.file-drafts.v1";
export const FILE_EDITOR_RECOVERY_LIMITS = {
	maxDrafts: 32,
	maxDraftBytes: 512 * 1024,
	maxBytes: 2 * 1024 * 1024,
	maxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const;

const textIdentity = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => !value.includes("\0"));
const relativePath = textIdentity.refine(
	(value) =>
		!value.startsWith("/") &&
		!value.includes("\\") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
);
const scopeSchema = z
	.object({
		projectId: textIdentity,
		taskId: textIdentity.nullable(),
		taskCreatedAt: z.number().finite().nonnegative().optional(),
		rootPath: textIdentity.refine((value) => value.startsWith("/")),
	})
	.strict()
	.refine((scope) => scope.taskId === null || scope.taskCreatedAt !== undefined);
const tabSchema = z
	.object({
		path: relativePath,
		value: z.string(),
		savedValue: z.string(),
		contentHash: z.string().max(4096).nullable(),
		language: z.string().max(256),
		binary: z.literal(false),
		truncated: z.literal(false),
		editable: z.boolean(),
		editBlockedReason: z.string().max(4096).nullable(),
		size: z.number().finite().nonnegative(),
	})
	.strict();
const recordSchema = z
	.object({
		id: textIdentity,
		scopeKey: textIdentity,
		scope: scopeSchema,
		tab: tabSchema,
		updatedAt: z.number().finite().nonnegative(),
	})
	.strict();
const snapshotSchema = z
	.object({ schemaVersion: z.literal(1), drafts: z.array(recordSchema).max(FILE_EDITOR_RECOVERY_LIMITS.maxDrafts) })
	.strict();

export type FileEditorRecoveryRecord = z.infer<typeof recordSchema>;
export type FileEditorRecoveryProblem = "invalid" | "limit" | "storage" | "identity";
export interface FileEditorRecoveryLoad {
	readonly drafts: readonly FileEditorRecoveryRecord[];
	readonly expired: number;
	readonly problem: FileEditorRecoveryProblem | null;
}

/** Count UTF-16 storage bytes conservatively, including JSON escaping and metadata. */
function bytes(value: string): number {
	return value.length * 2;
}

export function decodeFileEditorRecovery(raw: string | null, now: number): FileEditorRecoveryLoad {
	if (raw === null) return { drafts: [], expired: 0, problem: null };
	try {
		if (bytes(raw) > FILE_EDITOR_RECOVERY_LIMITS.maxBytes) return { drafts: [], expired: 0, problem: "limit" };
		const result = snapshotSchema.safeParse(JSON.parse(raw));
		if (!result.success) return { drafts: [], expired: 0, problem: "invalid" };
		const drafts: FileEditorRecoveryRecord[] = [];
		const ids = new Set<string>();
		let expired = 0;
		for (const draft of result.data.drafts) {
			if (ids.has(draft.id) || draft.updatedAt > now + 300_000 || draft.tab.value === draft.tab.savedValue)
				return { drafts: [], expired: 0, problem: "invalid" };
			if (bytes(JSON.stringify(draft)) > FILE_EDITOR_RECOVERY_LIMITS.maxDraftBytes)
				return { drafts: [], expired: 0, problem: "limit" };
			ids.add(draft.id);
			if (now - draft.updatedAt > FILE_EDITOR_RECOVERY_LIMITS.maxAgeMs) expired++;
			else drafts.push(draft);
		}
		return { drafts, expired, problem: null };
	} catch {
		return { drafts: [], expired: 0, problem: "invalid" };
	}
}

export function sameFileEditorRecoveryScope(a: FileEditorScopeIdentity, b: FileEditorScopeIdentity): boolean {
	return (
		scopeSchema.safeParse(a).success &&
		scopeSchema.safeParse(b).success &&
		a.projectId === b.projectId &&
		a.taskId === b.taskId &&
		a.taskCreatedAt === b.taskCreatedAt &&
		a.rootPath === b.rootPath
	);
}

export type FileEditorRecoveryWrite =
	| { readonly ok: true; readonly raw: string; readonly drafts: readonly FileEditorRecoveryRecord[] }
	| { readonly ok: false; readonly problem: FileEditorRecoveryProblem };

/** Never evict current unsaved text to fit the quota: the caller keeps the previous durable snapshot on refusal. */
export function encodeFileEditorRecovery(
	drafts: readonly FileEditorDraft[],
	previous: readonly FileEditorRecoveryRecord[],
	now: number,
): FileEditorRecoveryWrite {
	const records: FileEditorRecoveryRecord[] = [];
	const ids = new Set<string>();
	for (const draft of drafts) {
		if (draft.tab.value === draft.tab.savedValue) continue;
		const { path, value, savedValue, contentHash, language, binary, truncated, editable, editBlockedReason, size } =
			draft.tab;
		if (bytes(value) + bytes(savedValue) > FILE_EDITOR_RECOVERY_LIMITS.maxDraftBytes)
			return { ok: false, problem: "limit" };
		const id = draft.recoveryId ?? JSON.stringify([draft.scopeKey, draft.generation, path]);
		if (ids.has(id)) return { ok: false, problem: "identity" };
		ids.add(id);
		const old = previous.find(
			(candidate) => candidate.id === id && sameFileEditorRecoveryScope(candidate.scope, draft.scope),
		);
		const parsed = recordSchema.safeParse({
			id,
			scopeKey: draft.scopeKey,
			scope: draft.scope,
			tab: { path, value, savedValue, contentHash, language, binary, truncated, editable, editBlockedReason, size },
			updatedAt:
				old &&
				JSON.stringify(old.tab) ===
					JSON.stringify({
						path,
						value,
						savedValue,
						contentHash,
						language,
						binary,
						truncated,
						editable,
						editBlockedReason,
						size,
					})
					? old.updatedAt
					: now,
		});
		if (!parsed.success) return { ok: false, problem: "identity" };
		if (bytes(JSON.stringify(parsed.data)) > FILE_EDITOR_RECOVERY_LIMITS.maxDraftBytes)
			return { ok: false, problem: "limit" };
		records.push(parsed.data);
	}
	if (records.length > FILE_EDITOR_RECOVERY_LIMITS.maxDrafts) return { ok: false, problem: "limit" };
	const raw = JSON.stringify({ schemaVersion: 1, drafts: records });
	return bytes(raw) > FILE_EDITOR_RECOVERY_LIMITS.maxBytes
		? { ok: false, problem: "limit" }
		: { ok: true, raw, drafts: records };
}
