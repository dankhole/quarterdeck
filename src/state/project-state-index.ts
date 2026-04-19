import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";

import type { RuntimeBoardColumnId, RuntimeBoardData, RuntimeTaskSessionSummary } from "../core";
import { canonicalizeTaskBoard, runtimeBoardDataSchema, runtimeTaskSessionSummarySchema } from "../core";
import { isNodeError, lockedFileSystem } from "../fs";
import {
	getProjectBoardPath,
	getProjectIndexLockRequest,
	getProjectIndexPath,
	getProjectMetaPath,
	getProjectSessionsPath,
	isUnderWorktreesHome,
} from "./project-state-utils";

const INDEX_VERSION = 1;
const PROJECT_ID_COLLISION_SUFFIX_LENGTH = 4;

const BOARD_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "trash", title: "Trash" },
];

export interface ProjectIndexEntry {
	projectId: string;
	repoPath: string;
}

export interface RuntimeProjectIndexEntry {
	projectId: string;
	repoPath: string;
}

interface ProjectIndexFile {
	version: number;
	entries: Record<string, ProjectIndexEntry>;
	repoPathToId: Record<string, string>;
	projectOrder: string[];
}

export interface ProjectStateMeta {
	revision: number;
	updatedAt: number;
}

export const projectStateMetaSchema = z.object({
	revision: z.number().int().nonnegative(),
	updatedAt: z.number(),
});

const projectIndexEntrySchema = z.object({
	projectId: z.string().min(1, "Project ID cannot be empty."),
	repoPath: z.string().min(1, "Project repository path cannot be empty."),
});

const projectIndexFileSchema = z
	.object({
		version: z.literal(INDEX_VERSION),
		entries: z.record(z.string(), projectIndexEntrySchema),
		repoPathToId: z.record(z.string(), z.string().min(1, "Project ID cannot be empty.")),
		projectOrder: z.array(z.string()).optional().default([]),
	})
	.superRefine((index, context) => {
		for (const [projectId, entry] of Object.entries(index.entries)) {
			if (entry.projectId !== projectId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", projectId, "projectId"],
					message: `Project ID must match entry key "${projectId}".`,
				});
			}
			const mappedProjectId = index.repoPathToId[entry.repoPath];
			if (mappedProjectId !== projectId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", projectId, "repoPath"],
					message: `Missing repoPathToId mapping for "${entry.repoPath}" to "${projectId}".`,
				});
			}
		}

		for (const [repoPath, projectId] of Object.entries(index.repoPathToId)) {
			const entry = index.entries[projectId];
			if (!entry) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped project "${projectId}" does not exist in entries.`,
				});
				continue;
			}
			if (entry.repoPath !== repoPath) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped repoPath does not match project entry path "${entry.repoPath}".`,
				});
			}
		}
	});

const projectSessionsSchema = z.record(z.string(), runtimeTaskSessionSummarySchema).superRefine((sessions, context) => {
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

function formatSchemaIssues(error: z.ZodError, maxIssues = 5): string {
	const issues = error.issues;
	const formatted = issues
		.slice(0, maxIssues)
		.map((issue) => `${formatSchemaIssuePath(issue.path)}: ${issue.message}`);
	if (issues.length > maxIssues) {
		formatted.push(`(${issues.length - maxIssues} more)`);
	}
	return formatted.join("; ");
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

function createEmptyProjectIndex(): ProjectIndexFile {
	return {
		version: INDEX_VERSION,
		entries: {},
		repoPathToId: {},
		projectOrder: [],
	};
}

function parseProjectIndex(rawIndex: unknown | null): ProjectIndexFile {
	const indexPath = getProjectIndexPath();
	return parsePersistedStateFile(indexPath, "index.json", rawIndex, projectIndexFileSchema, createEmptyProjectIndex());
}

export function parseProjectStateSavePayload<T>(payload: T, schema: z.ZodType<T>): T {
	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`Invalid project state save payload. ${formatSchemaIssues(parsed.error)}`);
	}
	return parsed.data;
}

export async function readProjectBoard(projectId: string): Promise<RuntimeBoardData> {
	const boardPath = getProjectBoardPath(projectId);
	const rawBoard = await readJsonFile(boardPath);
	return canonicalizeTaskBoard(
		parsePersistedStateFile(boardPath, "board.json", rawBoard, runtimeBoardDataSchema, createEmptyBoard()),
	);
}

export async function loadProjectBoardById(projectId: string): Promise<RuntimeBoardData> {
	return await readProjectBoard(projectId);
}

export async function readProjectSessions(projectId: string): Promise<Record<string, RuntimeTaskSessionSummary>> {
	const sessionsPath = getProjectSessionsPath(projectId);
	const rawSessions = await readJsonFile(sessionsPath);
	return parsePersistedStateFile(sessionsPath, "sessions.json", rawSessions, projectSessionsSchema, {});
}

export async function readProjectMeta(projectId: string): Promise<ProjectStateMeta> {
	const metaPath = getProjectMetaPath(projectId);
	const rawMeta = await readJsonFile(metaPath);
	return parsePersistedStateFile(metaPath, "meta.json", rawMeta, projectStateMetaSchema, {
		revision: 0,
		updatedAt: 0,
	});
}

// --- Index CRUD ---

export async function readProjectIndex(): Promise<ProjectIndexFile> {
	const raw = await readJsonFile(getProjectIndexPath());
	return parseProjectIndex(raw);
}

async function writeProjectIndex(index: ProjectIndexFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getProjectIndexPath(), index, {
		lock: null,
	});
}

function toProjectIdBase(repoPath: string): string {
	const trimmed = repoPath.trim().replace(/[\\/]+$/g, "");
	const folderName = basename(trimmed) || "project";
	const normalized = folderName
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "project";
}

function createProjectIdCollisionSuffix(length: number): string {
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

function createProjectId(index: ProjectIndexFile, repoPath: string): string {
	const baseId = toProjectIdBase(repoPath);
	if (!index.entries[baseId] || index.entries[baseId]?.repoPath === repoPath) {
		return baseId;
	}

	for (let attempt = 0; attempt < 256; attempt += 1) {
		const candidate = `${baseId}-${createProjectIdCollisionSuffix(PROJECT_ID_COLLISION_SUFFIX_LENGTH)}`;
		if (!index.entries[candidate] || index.entries[candidate]?.repoPath === repoPath) {
			return candidate;
		}
	}

	throw new Error(`Could not generate a unique project ID for ${repoPath}.`);
}

export function ensureProjectEntry(
	index: ProjectIndexFile,
	repoPath: string,
): { index: ProjectIndexFile; entry: ProjectIndexEntry; changed: boolean } {
	if (isUnderWorktreesHome(repoPath)) {
		throw new Error(`Cannot add a Quarterdeck worktree as a project: ${repoPath}`);
	}

	const existingProjectId = index.repoPathToId[repoPath];
	if (existingProjectId) {
		const existingEntry = index.entries[existingProjectId];
		if (existingEntry && existingEntry.repoPath === repoPath) {
			return {
				index,
				entry: existingEntry,
				changed: false,
			};
		}
	}

	const projectId = createProjectId(index, repoPath);

	const entry: ProjectIndexEntry = {
		projectId,
		repoPath,
	};

	return {
		index: {
			version: INDEX_VERSION,
			entries: {
				...index.entries,
				[projectId]: entry,
			},
			repoPathToId: {
				...index.repoPathToId,
				[repoPath]: projectId,
			},
			projectOrder: [...index.projectOrder, projectId],
		},
		entry,
		changed: true,
	};
}

export function findProjectEntry(index: ProjectIndexFile, repoPath: string): ProjectIndexEntry | null {
	const projectId = index.repoPathToId[repoPath];
	if (!projectId) {
		return null;
	}
	const entry = index.entries[projectId];
	if (!entry || entry.repoPath !== repoPath) {
		return null;
	}
	return entry;
}

export async function listProjectIndexEntries(): Promise<RuntimeProjectIndexEntry[]> {
	const index = await readProjectIndex();
	const entries = Object.values(index.entries).map((entry) => ({
		projectId: entry.projectId,
		repoPath: entry.repoPath,
	}));
	const order = index.projectOrder;
	if (order.length === 0) {
		return entries.sort((left, right) => left.repoPath.localeCompare(right.repoPath));
	}
	const positionMap = new Map(order.map((id, i) => [id, i]));
	return entries.sort((left, right) => {
		const leftPos = positionMap.get(left.projectId) ?? Number.MAX_SAFE_INTEGER;
		const rightPos = positionMap.get(right.projectId) ?? Number.MAX_SAFE_INTEGER;
		if (leftPos !== rightPos) {
			return leftPos - rightPos;
		}
		return left.repoPath.localeCompare(right.repoPath);
	});
}

export async function removeProjectIndexEntry(projectId: string): Promise<boolean> {
	return await lockedFileSystem.withLock(getProjectIndexLockRequest(), async () => {
		const index = await readProjectIndex();
		const entry = index.entries[projectId];
		if (!entry) {
			return false;
		}
		delete index.entries[projectId];
		delete index.repoPathToId[entry.repoPath];
		index.projectOrder = index.projectOrder.filter((id) => id !== projectId);
		await writeProjectIndex(index);
		return true;
	});
}

export async function updateProjectOrder(orderedIds: string[]): Promise<void> {
	await lockedFileSystem.withLock(getProjectIndexLockRequest(), async () => {
		const index = await readProjectIndex();
		const validIds = orderedIds.filter((id) => index.entries[id] !== undefined);
		const includedIds = new Set(validIds);
		const missingIds = Object.keys(index.entries).filter((id) => !includedIds.has(id));
		index.projectOrder = [...validIds, ...missingIds];
		await writeProjectIndex(index);
	});
}

export async function writeProjectIndexSafe(index: ProjectIndexFile): Promise<void> {
	await writeProjectIndex(index);
}
