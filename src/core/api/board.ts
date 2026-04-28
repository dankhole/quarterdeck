import { z } from "zod";
import { runtimeBoardColumnIdSchema, runtimeTaskImageSchema } from "./shared.js";

export const runtimeBoardCardSchema = z.object({
	id: z.string(),
	title: z.string().nullable().default(null),
	prompt: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	baseRef: z.string(),
	baseRefPinned: z.boolean().optional(),
	useWorktree: z.boolean().optional(),
	workingDirectory: z.string().min(1).nullable().optional(),
	branch: z.string().min(1).nullable().optional(),
	pinned: z.boolean().optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type RuntimeBoardCard = z.infer<typeof runtimeBoardCardSchema>;

export const runtimeBoardColumnSchema = z.object({
	id: runtimeBoardColumnIdSchema,
	title: z.string(),
	cards: z.array(runtimeBoardCardSchema),
});
export type RuntimeBoardColumn = z.infer<typeof runtimeBoardColumnSchema>;

export const runtimeBoardDependencySchema = z.object({
	id: z.string(),
	fromTaskId: z.string(),
	toTaskId: z.string(),
	createdAt: z.number(),
});
export type RuntimeBoardDependency = z.infer<typeof runtimeBoardDependencySchema>;

export const runtimeBoardDataSchema = z.object({
	columns: z.array(runtimeBoardColumnSchema),
	dependencies: z.array(runtimeBoardDependencySchema).default([]),
});
export type RuntimeBoardData = z.infer<typeof runtimeBoardDataSchema>;
