import { z } from "zod";

const identitySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
const refSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => !/[\p{Cc}]/u.test(value));
const selectedPathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(value) =>
			!/[\\\p{Cc}]/u.test(value) &&
			!value.startsWith("/") &&
			value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0),
	);

/** Navigation data only. Repository paths and task authority come from runtime state. */
export const compareWindowTargetSchema = z
	.strictObject({
		projectId: identitySchema,
		taskId: identitySchema.nullable(),
		taskCreatedAt: z.number().int().nonnegative().optional(),
		sourceRef: refSchema,
		targetRef: refSchema,
		includeUncommitted: z.boolean(),
		threeDotDiff: z.boolean(),
		selectedPath: selectedPathSchema.optional(),
	})
	.refine((target) =>
		target.taskId === null ? target.taskCreatedAt === undefined : target.taskCreatedAt !== undefined,
	);

export type CompareWindowTarget = z.infer<typeof compareWindowTargetSchema>;

export const compareWindowOpenResponseSchema = z.strictObject({ kind: z.enum(["opened", "unavailable", "failed"]) });
export type CompareWindowOpenResponse = z.infer<typeof compareWindowOpenResponseSchema>;

export function buildCompareWindowPath(input: CompareWindowTarget): string {
	const target = compareWindowTargetSchema.parse(input);
	const query = new URLSearchParams({
		surface: "compare",
		sourceRef: target.sourceRef,
		targetRef: target.targetRef,
		includeUncommitted: String(target.includeUncommitted),
		threeDotDiff: String(target.threeDotDiff),
	});
	if (target.taskId !== null) {
		query.set("taskId", target.taskId);
		query.set("taskCreatedAt", String(target.taskCreatedAt));
	}
	if (target.selectedPath !== undefined) query.set("selectedPath", target.selectedPath);
	return `/${encodeURIComponent(target.projectId)}?${query}`;
}

/** Reject ambiguity rather than turning a malformed Compare request into the full app. */
export function parseCompareWindowTarget(url: URL): CompareWindowTarget | null {
	if (url.hash || url.username || url.password || !/^\/[^/]+$/u.test(url.pathname)) return null;
	const allowed = new Set([
		"surface",
		"taskId",
		"taskCreatedAt",
		"sourceRef",
		"targetRef",
		"includeUncommitted",
		"threeDotDiff",
		"selectedPath",
	]);
	for (const key of url.searchParams.keys()) {
		if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
	}
	if (url.searchParams.get("surface") !== "compare") return null;
	const includeUncommitted = url.searchParams.get("includeUncommitted");
	const threeDotDiff = url.searchParams.get("threeDotDiff");
	if (!["true", "false"].includes(includeUncommitted ?? "") || !["true", "false"].includes(threeDotDiff ?? ""))
		return null;
	try {
		const createdAt = url.searchParams.get("taskCreatedAt");
		if (createdAt !== null && !/^(?:0|[1-9]\d*)$/u.test(createdAt)) return null;
		const result = compareWindowTargetSchema.safeParse({
			projectId: decodeURIComponent(url.pathname.slice(1)),
			taskId: url.searchParams.get("taskId"),
			...(createdAt === null ? {} : { taskCreatedAt: Number(createdAt) }),
			sourceRef: url.searchParams.get("sourceRef"),
			targetRef: url.searchParams.get("targetRef"),
			includeUncommitted: includeUncommitted === "true",
			threeDotDiff: threeDotDiff === "true",
			...(url.searchParams.has("selectedPath") ? { selectedPath: url.searchParams.get("selectedPath") } : {}),
		});
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}
