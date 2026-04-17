import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";

import type { RuntimeBoardColumnId, RuntimeBoardData, RuntimeTaskSessionSummary } from "../core";
import { runtimeBoardDataSchema, runtimeTaskSessionSummarySchema, updateTaskDependencies } from "../core";
import { isNodeError, lockedFileSystem } from "../fs";
import {
	getWorkspaceBoardPath,
	getWorkspaceIndexLockRequest,
	getWorkspaceIndexPath,
	getWorkspaceMetaPath,
	getWorkspaceSessionsPath,
	isUnderWorktreesHome,
} from "./workspace-state-utils";

const INDEX_VERSION = 1;
const WORKSPACE_ID_COLLISION_SUFFIX_LENGTH = 4;

const BOARD_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "trash", title: "Trash" },
];

export interface WorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

export interface RuntimeWorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

interface WorkspaceIndexFile {
	version: number;
	entries: Record<string, WorkspaceIndexEntry>;
	repoPathToId: Record<string, string>;
	projectOrder: string[];
}

export interface WorkspaceStateMeta {
	revision: number;
	updatedAt: number;
}

export const workspaceStateMetaSchema = z.object({
	revision: z.number().int().nonnegative(),
	updatedAt: z.number(),
});

const workspaceIndexEntrySchema = z.object({
	workspaceId: z.string().min(1, "Workspace ID cannot be empty."),
	repoPath: z.string().min(1, "Workspace repository path cannot be empty."),
});

const workspaceIndexFileSchema = z
	.object({
		version: z.literal(INDEX_VERSION),
		entries: z.record(z.string(), workspaceIndexEntrySchema),
		repoPathToId: z.record(z.string(), z.string().min(1, "Workspace ID cannot be empty.")),
		projectOrder: z.array(z.string()).optional().default([]),
	})
	.superRefine((index, context) => {
		for (const [workspaceId, entry] of Object.entries(index.entries)) {
			if (entry.workspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "workspaceId"],
					message: `Workspace ID must match entry key "${workspaceId}".`,
				});
			}
			const mappedWorkspaceId = index.repoPathToId[entry.repoPath];
			if (mappedWorkspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "repoPath"],
					message: `Missing repoPathToId mapping for "${entry.repoPath}" to "${workspaceId}".`,
				});
			}
		}

		for (const [repoPath, workspaceId] of Object.entries(index.repoPathToId)) {
			const entry = index.entries[workspaceId];
			if (!entry) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped workspace "${workspaceId}" does not exist in entries.`,
				});
				continue;
			}
			if (entry.repoPath !== repoPath) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped repoPath does not match workspace entry path "${entry.repoPath}".`,
				});
			}
		}
	});

const workspaceSessionsSchema = z
	.record(z.string(), runtimeTaskSessionSummarySchema)
	.superRefine((sessions, context) => {
		for (const [taskId, session] of Object.entries(sessions)) {
			if (session.taskId !== taskId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [taskId, "taskId"],
					message: `Session taskId must match record key "${taskId}".`,
				});
			}
		}
	});

// --- JSON parsing helpers ---

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in ${path}. ${message}`);
		}
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read JSON file at ${path}. ${message}`);
	}
}

function formatSchemaIssuePath(pathSegments: PropertyKey[]): string {
	if (pathSegments.length === 0) {
		return "root";
	}
	return pathSegments
		.map((segment) => {
			if (typeof segment === "number") {
				return `[${segment}]`;
			}
			return String(segment);
		})
		.join(".");
}

function formatSchemaIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `${formatSchemaIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

function parsePersistedStateFile<T>(
	filePath: string,
	fileLabel: string,
	raw: unknown | null,
	schema: z.ZodType<T>,
	defaultValue: T,
): T {
	if (raw === null) {
		return defaultValue;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`Invalid ${fileLabel} file at ${filePath}. ` +
				`Fix or remove the file. Validation errors: ${formatSchemaIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}

// --- Board/Sessions/Meta I/O ---

export function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: BOARD_COLUMNS.map((column) => ({
			id: column.id,
			title: column.title,
			cards: [],
		})),
		dependencies: [],
	};
}

function createEmptyWorkspaceIndex(): WorkspaceIndexFile {
	return {
		version: INDEX_VERSION,
		entries: {},
		repoPathToId: {},
		projectOrder: [],
	};
}

function parseWorkspaceIndex(rawIndex: unknown | null): WorkspaceIndexFile {
	const indexPath = getWorkspaceIndexPath();
	return parsePersistedStateFile(
		indexPath,
		"index.json",
		rawIndex,
		workspaceIndexFileSchema,
		createEmptyWorkspaceIndex(),
	);
}

export function parseWorkspaceStateSavePayload<T>(payload: T, schema: z.ZodType<T>): T {
	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`Invalid workspace state save payload. ${formatSchemaIssues(parsed.error)}`);
	}
	return parsed.data;
}

export async function readWorkspaceBoard(workspaceId: string): Promise<RuntimeBoardData> {
	const boardPath = getWorkspaceBoardPath(workspaceId);
	const rawBoard = await readJsonFile(boardPath);
	return updateTaskDependencies(
		parsePersistedStateFile(boardPath, "board.json", rawBoard, runtimeBoardDataSchema, createEmptyBoard()),
	);
}

export async function loadWorkspaceBoardById(workspaceId: string): Promise<RuntimeBoardData> {
	return await readWorkspaceBoard(workspaceId);
}

export async function readWorkspaceSessions(workspaceId: string): Promise<Record<string, RuntimeTaskSessionSummary>> {
	const sessionsPath = getWorkspaceSessionsPath(workspaceId);
	const rawSessions = await readJsonFile(sessionsPath);
	return parsePersistedStateFile(sessionsPath, "sessions.json", rawSessions, workspaceSessionsSchema, {});
}

export async function readWorkspaceMeta(workspaceId: string): Promise<WorkspaceStateMeta> {
	const metaPath = getWorkspaceMetaPath(workspaceId);
	const rawMeta = await readJsonFile(metaPath);
	return parsePersistedStateFile(metaPath, "meta.json", rawMeta, workspaceStateMetaSchema, {
		revision: 0,
		updatedAt: 0,
	});
}

// --- Index CRUD ---

export async function readWorkspaceIndex(): Promise<WorkspaceIndexFile> {
	const raw = await readJsonFile(getWorkspaceIndexPath());
	return parseWorkspaceIndex(raw);
}

async function writeWorkspaceIndex(index: WorkspaceIndexFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getWorkspaceIndexPath(), index, {
		lock: null,
	});
}

function toWorkspaceIdBase(repoPath: string): string {
	const trimmed = repoPath.trim().replace(/[\\/]+$/g, "");
	const folderName = basename(trimmed) || "project";
	const normalized = folderName
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "project";
}

function createWorkspaceIdCollisionSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	while (suffix.length < length) {
		const bytes = randomBytes(length);
		for (const byte of bytes) {
			suffix += alphabet[byte % alphabet.length] ?? "";
			if (suffix.length === length) {
				break;
			}
		}
	}
	return suffix;
}

function createWorkspaceId(index: WorkspaceIndexFile, repoPath: string): string {
	const baseId = toWorkspaceIdBase(repoPath);
	if (!index.entries[baseId] || index.entries[baseId]?.repoPath === repoPath) {
		return baseId;
	}

	for (let attempt = 0; attempt < 256; attempt += 1) {
		const candidate = `${baseId}-${createWorkspaceIdCollisionSuffix(WORKSPACE_ID_COLLISION_SUFFIX_LENGTH)}`;
		if (!index.entries[candidate] || index.entries[candidate]?.repoPath === repoPath) {
			return candidate;
		}
	}

	throw new Error(`Could not generate a unique workspace ID for ${repoPath}.`);
}

export function ensureWorkspaceEntry(
	index: WorkspaceIndexFile,
	repoPath: string,
): { index: WorkspaceIndexFile; entry: WorkspaceIndexEntry; changed: boolean } {
	if (isUnderWorktreesHome(repoPath)) {
		throw new Error(`Cannot add a Quarterdeck worktree as a project: ${repoPath}`);
	}

	const existingWorkspaceId = index.repoPathToId[repoPath];
	if (existingWorkspaceId) {
		const existingEntry = index.entries[existingWorkspaceId];
		if (existingEntry && existingEntry.repoPath === repoPath) {
			return {
				index,
				entry: existingEntry,
				changed: false,
			};
		}
	}

	const workspaceId = createWorkspaceId(index, repoPath);

	const entry: WorkspaceIndexEntry = {
		workspaceId,
		repoPath,
	};

	return {
		index: {
			version: INDEX_VERSION,
			entries: {
				...index.entries,
				[workspaceId]: entry,
			},
			repoPathToId: {
				...index.repoPathToId,
				[repoPath]: workspaceId,
			},
			projectOrder: [...index.projectOrder, workspaceId],
		},
		entry,
		changed: true,
	};
}

export function findWorkspaceEntry(index: WorkspaceIndexFile, repoPath: string): WorkspaceIndexEntry | null {
	const workspaceId = index.repoPathToId[repoPath];
	if (!workspaceId) {
		return null;
	}
	const entry = index.entries[workspaceId];
	if (!entry || entry.repoPath !== repoPath) {
		return null;
	}
	return entry;
}

export async function listWorkspaceIndexEntries(): Promise<RuntimeWorkspaceIndexEntry[]> {
	const index = await readWorkspaceIndex();
	const entries = Object.values(index.entries).map((entry) => ({
		workspaceId: entry.workspaceId,
		repoPath: entry.repoPath,
	}));
	const order = index.projectOrder;
	if (order.length === 0) {
		return entries.sort((left, right) => left.repoPath.localeCompare(right.repoPath));
	}
	const positionMap = new Map(order.map((id, i) => [id, i]));
	return entries.sort((left, right) => {
		const leftPos = positionMap.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER;
		const rightPos = positionMap.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER;
		if (leftPos !== rightPos) {
			return leftPos - rightPos;
		}
		return left.repoPath.localeCompare(right.repoPath);
	});
}

export async function removeWorkspaceIndexEntry(workspaceId: string): Promise<boolean> {
	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		const index = await readWorkspaceIndex();
		const entry = index.entries[workspaceId];
		if (!entry) {
			return false;
		}
		delete index.entries[workspaceId];
		delete index.repoPathToId[entry.repoPath];
		index.projectOrder = index.projectOrder.filter((id) => id !== workspaceId);
		await writeWorkspaceIndex(index);
		return true;
	});
}

export async function updateProjectOrder(orderedIds: string[]): Promise<void> {
	await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		const index = await readWorkspaceIndex();
		const validIds = orderedIds.filter((id) => index.entries[id] !== undefined);
		const includedIds = new Set(validIds);
		const missingIds = Object.keys(index.entries).filter((id) => !includedIds.has(id));
		index.projectOrder = [...validIds, ...missingIds];
		await writeWorkspaceIndex(index);
	});
}

export async function writeWorkspaceIndexSafe(index: WorkspaceIndexFile): Promise<void> {
	await writeWorkspaceIndex(index);
}
