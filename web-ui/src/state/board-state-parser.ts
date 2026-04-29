import { runtimeBoardColumnIdSchema, runtimeTaskImageSchema } from "@runtime-contract";
import { z } from "zod";
import type { BoardCard, BoardColumnId, BoardDependency, TaskImage } from "@/types";

const rawPersistedBoardSchema = z.object({
	columns: z.array(z.unknown()),
	dependencies: z.array(z.unknown()).optional(),
});

const rawPersistedBoardColumnSchema = z.object({
	id: z.unknown(),
	cards: z.unknown().optional(),
});

const rawPersistedBoardCardSchema = z.object({
	id: z.unknown().optional(),
	title: z.unknown().optional(),
	prompt: z.unknown().optional(),
	images: z.unknown().optional(),
	baseRef: z.unknown().optional(),
	baseRefPinned: z.unknown().optional(),
	useWorktree: z.unknown().optional(),
	workingDirectory: z.unknown().optional(),
	branch: z.unknown().optional(),
	pinned: z.unknown().optional(),
	createdAt: z.unknown().optional(),
	updatedAt: z.unknown().optional(),
});

const rawPersistedBoardDependencySchema = z.object({
	id: z.unknown().optional(),
	fromTaskId: z.unknown().optional(),
	toTaskId: z.unknown().optional(),
	createdAt: z.unknown().optional(),
});

export interface ParsedPersistedBoardColumn {
	id: BoardColumnId;
	cards: unknown[];
}

export interface ParsedPersistedBoardPayload {
	columns: ParsedPersistedBoardColumn[];
	dependencies: unknown[];
}

export function parsePersistedBoardPayload(rawBoard: unknown): ParsedPersistedBoardPayload | null {
	const result = rawPersistedBoardSchema.safeParse(rawBoard);
	if (!result.success) {
		return null;
	}

	const columns: ParsedPersistedBoardColumn[] = [];
	for (const rawColumn of result.data.columns) {
		const column = parsePersistedBoardColumn(rawColumn);
		if (column) {
			columns.push(column);
		}
	}

	return {
		columns,
		dependencies: result.data.dependencies ?? [],
	};
}

export function parsePersistedBoardCard(
	rawCard: unknown,
	options: { createTaskId: () => string; now?: number },
): BoardCard | null {
	const result = rawPersistedBoardCardSchema.safeParse(rawCard);
	if (!result.success) {
		return null;
	}

	const prompt = parseRequiredTrimmedString(result.data.prompt);
	if (!prompt) {
		return null;
	}

	const baseRef = parseTrimmedString(result.data.baseRef);
	if (baseRef === null) {
		return null;
	}

	const now = options.now ?? Date.now();

	return {
		id: parseNonEmptyString(result.data.id) ?? options.createTaskId(),
		title: typeof result.data.title === "string" ? result.data.title : null,
		prompt,
		images: parsePersistedTaskImages(result.data.images),
		baseRef,
		...(typeof result.data.baseRefPinned === "boolean" ? { baseRefPinned: result.data.baseRefPinned } : {}),
		useWorktree: typeof result.data.useWorktree === "boolean" ? result.data.useWorktree : undefined,
		workingDirectory: parseOptionalNullableString(result.data.workingDirectory),
		branch: parseOptionalNullableString(result.data.branch),
		pinned: typeof result.data.pinned === "boolean" ? result.data.pinned : undefined,
		createdAt: typeof result.data.createdAt === "number" ? result.data.createdAt : now,
		updatedAt: typeof result.data.updatedAt === "number" ? result.data.updatedAt : now,
	};
}

export function parsePersistedBoardDependency(
	rawDependency: unknown,
	options: { createDependencyId: () => string; now?: number },
): BoardDependency | null {
	const result = rawPersistedBoardDependencySchema.safeParse(rawDependency);
	if (!result.success) {
		return null;
	}

	const fromTaskId = parseRequiredTrimmedString(result.data.fromTaskId);
	const toTaskId = parseRequiredTrimmedString(result.data.toTaskId);
	if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) {
		return null;
	}

	return {
		id: parseNonEmptyString(result.data.id) ?? options.createDependencyId(),
		fromTaskId,
		toTaskId,
		createdAt: typeof result.data.createdAt === "number" ? result.data.createdAt : (options.now ?? Date.now()),
	};
}

export function parsePersistedTaskImages(rawImages: unknown): TaskImage[] | undefined {
	const result = z.array(z.unknown()).safeParse(rawImages);
	if (!result.success) {
		return undefined;
	}

	const images = result.data.flatMap((rawImage) => {
		const image = runtimeTaskImageSchema.safeParse(rawImage);
		return image.success ? [image.data] : [];
	});
	return images.length > 0 ? images : undefined;
}

function parsePersistedBoardColumn(rawColumn: unknown): ParsedPersistedBoardColumn | null {
	const result = rawPersistedBoardColumnSchema.safeParse(rawColumn);
	if (!result.success) {
		return null;
	}

	const columnId = parseBoardColumnId(result.data.id);
	const cards = z.array(z.unknown()).safeParse(result.data.cards);
	if (!columnId || !cards.success) {
		return null;
	}

	return {
		id: columnId,
		cards: cards.data,
	};
}

function parseBoardColumnId(value: unknown): BoardColumnId | null {
	const result = runtimeBoardColumnIdSchema.safeParse(value);
	return result.success ? result.data : null;
}

function parseNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function parseRequiredTrimmedString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function parseTrimmedString(value: unknown): string | null {
	return typeof value === "string" ? value.trim() : null;
}

function parseOptionalNullableString(value: unknown): string | null | undefined {
	if (typeof value === "string") {
		return value;
	}
	return value === null ? null : undefined;
}
