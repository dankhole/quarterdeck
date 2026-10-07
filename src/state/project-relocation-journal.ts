import { open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import { isNodeError } from "../fs/node-error";
import { getProjectDirectoryLockRequest, getProjectDirectoryPath } from "./project-state-utils";
import { assertRuntimeWriteAdmission } from "./runtime-write-admission.js";

const directoryIdentitySchema = z.object({ device: z.string(), inode: z.string() });
const projectRelocationPlanSchema = z.object({
	operationId: z.string().min(1),
	projectId: z.string().min(1),
	oldPath: z.string().min(1),
	newPath: z.string().min(1),
	kind: z.enum(["locate", "rename"]),
	folderOnly: z.boolean(),
	directoryIdentity: directoryIdentitySchema,
	worktrees: z.array(z.object({ path: z.string(), originalPath: z.string(), gitAdminName: z.string() })),
	taskWorkingDirectories: z.record(z.string(), z.string()),
});

export type ProjectRelocationPlan = z.infer<typeof projectRelocationPlanSchema>;

const projectRelocationJournalSchema = projectRelocationPlanSchema.extend({
	version: z.literal(1),
	phase: z.enum(["prepared", "filesystem_applied", "index_committed"]),
});
export type ProjectRelocationJournal = z.infer<typeof projectRelocationJournalSchema>;

export function getProjectRelocationJournalPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), "relocation.json");
}

export async function readProjectRelocationJournal(projectId: string): Promise<ProjectRelocationJournal | null> {
	try {
		const journal = projectRelocationJournalSchema.parse(
			JSON.parse(await readFile(getProjectRelocationJournalPath(projectId), "utf8")),
		);
		if (journal.projectId !== projectId) throw new Error("Project relocation journal identity does not match.");
		return journal;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function syncPath(path: string): Promise<void> {
	const handle = await open(path, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncJournalDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(dirname(path), "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Runtime project exclusion owns the operation; the file lock protects journal replacement. */
export async function writeProjectRelocationJournal(
	plan: ProjectRelocationPlan,
	phase: ProjectRelocationJournal["phase"],
): Promise<void> {
	const path = getProjectRelocationJournalPath(plan.projectId);
	await lockedFileSystem.withLocks([getProjectDirectoryLockRequest(plan.projectId), { path }], async () => {
		const existing = await readProjectRelocationJournal(plan.projectId);
		if (existing && existing.operationId !== plan.operationId) {
			throw new Error("Another folder relocation is awaiting recovery.");
		}
		await lockedFileSystem.writeJsonFileAtomic(
			path,
			projectRelocationJournalSchema.parse({ ...plan, version: 1, phase }),
			{ lock: null },
		);
		await syncPath(path);
		await syncJournalDirectory(path);
	});
}

export async function finalizeProjectRelocation(plan: ProjectRelocationPlan): Promise<void> {
	const path = getProjectRelocationJournalPath(plan.projectId);
	await lockedFileSystem.withLocks([getProjectDirectoryLockRequest(plan.projectId), { path }], async () => {
		const existing = await readProjectRelocationJournal(plan.projectId);
		if (!existing) return;
		if (existing.operationId !== plan.operationId) throw new Error("Project relocation identity changed.");
		assertRuntimeWriteAdmission(path);
		await unlink(path);
		await syncJournalDirectory(path);
	});
}
