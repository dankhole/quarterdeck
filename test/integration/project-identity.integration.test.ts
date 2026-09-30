import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveProjectSummary, type RuntimeBoardData } from "../../src/core";
import {
	applyProjectBoardMutationById,
	loadProjectContext,
	loadProjectScopeById,
	loadProjectState,
	loadSavedProjectStateById,
	saveProjectState,
	updateProjectIndexMetadata,
} from "../../src/state";
import {
	finalizeProjectRelocation,
	type ProjectRelocationPlan,
	writeProjectRelocationJournal,
} from "../../src/state/project-relocation-journal";
import { readProjectIndex, updateProjectOrganization } from "../../src/state/project-state-index";
import { getProjectIndexPath } from "../../src/state/project-state-utils";
import { createBackup, restoreBackup } from "../../src/state/state-backup";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalBackupHome = process.env.QUARTERDECK_BACKUP_HOME;
let root: ReturnType<typeof createTempDir>;

beforeEach(() => {
	root = createTempDir("quarterdeck-project-identity-");
	process.env.QUARTERDECK_STATE_HOME = join(root.path, "state");
	process.env.QUARTERDECK_BACKUP_HOME = join(root.path, "backups");
});

afterEach(() => {
	root.cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
	if (originalBackupHome === undefined) delete process.env.QUARTERDECK_BACKUP_HOME;
	else process.env.QUARTERDECK_BACKUP_HOME = originalBackupHome;
});

async function createProject(name: string) {
	const path = join(root.path, name);
	await mkdir(path);
	return await loadProjectContext(path, { folderOnly: true });
}

function board(path: string): RuntimeBoardData {
	return {
		columns: [
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Retained task",
						prompt: "Synthetic task",
						baseRef: "",
						workingDirectory: path,
						useWorktree: false,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Trash", cards: [] },
		],
	};
}

describe("stable project identity", { concurrent: false }, () => {
	it.each([1, 2])("loads a version %s index without a historical directory identity", async (version) => {
		const project = await createProject("legacy");
		const index = await readProjectIndex();
		index.version = version;
		index.entries[project.projectId] = { projectId: project.projectId, repoPath: project.repoPath, folderOnly: true };
		if (version === 2) index.organization = { id: randomUUID(), revision: 0, groups: [], membership: {} };
		await writeFile(getProjectIndexPath(), JSON.stringify(index));

		expect(await loadProjectScopeById(project.projectId)).toMatchObject({ metadataRevision: 0 });
		expect((await loadProjectScopeById(project.projectId))?.directoryIdentity).toBeUndefined();
		await updateProjectIndexMetadata({ projectId: project.projectId, displayName: "  Legacy project  " });
		expect((await readProjectIndex()).version).toBe(3);
		expect((await loadProjectScopeById(project.projectId))?.displayName).toBe("Legacy project");
	});

	it("retains saved board and sessions by ID when the folder disappears and migrates paths under the state transaction", async () => {
		const project = await createProject("original");
		const session = createTestTaskSessionSummary({
			taskId: "task-1",
			resumeSessionId: "opaque-provider-identity",
			sessionLaunchPath: project.repoPath,
		});
		await saveProjectState(project.repoPath, { board: board(project.repoPath), sessions: { "task-1": session } });
		const before = await loadProjectState(project.repoPath);
		const movedPath = join(root.path, "moved");
		await rename(project.repoPath, movedPath);

		const saved = await loadSavedProjectStateById(project.projectId);
		expect(saved).toMatchObject({
			repoPath: project.repoPath,
			board: before.board,
			sessions: before.sessions,
			revision: before.revision,
		});
		const migrated = await applyProjectBoardMutationById(project.projectId, {
			expectedRevision: before.revision,
			sessions: { "task-1": { ...session, sessionLaunchPath: movedPath } },
			mutate: (current) => ({
				changed: true,
				board: {
					...current,
					columns: current.columns.map((column) => ({
						...column,
						cards: column.cards.map((card) => ({ ...card, workingDirectory: movedPath })),
					})),
				},
			}),
		});
		expect(migrated.state.revision).toBe(before.revision + 1);
		expect(migrated.state.sessions["task-1"]).toMatchObject({
			sessionLaunchPath: movedPath,
			resumeSessionId: session.resumeSessionId,
		});
		expect((await loadSavedProjectStateById(project.projectId))?.board.columns[1]?.cards[0]?.workingDirectory).toBe(
			movedPath,
		);
		expect(Object.keys((await readProjectIndex()).entries)).toEqual([project.projectId]);
	});

	it("updates location and display metadata without changing ID, order, membership, or board revision", async () => {
		const project = await createProject("original");
		const second = await createProject("other");
		const groupId = randomUUID();
		await updateProjectOrganization({
			expectedRevision: 0,
			command: { type: "create", id: groupId, name: "Work", projectIds: [project.projectId] },
		});
		await saveProjectState(project.repoPath, { board: board(project.repoPath), sessions: {} });
		const before = await readProjectIndex();
		const oldRevision = (await loadSavedProjectStateById(project.projectId))?.revision;
		const movedPath = join(root.path, "renamed");
		const updated = await updateProjectIndexMetadata({
			projectId: project.projectId,
			expectedPath: project.repoPath,
			repoPath: movedPath,
			displayName: "Team workspace",
		});
		const index = await readProjectIndex();
		expect(index.repoPathToId[project.repoPath]).toBeUndefined();
		expect(index.repoPathToId[movedPath]).toBe(project.projectId);
		expect(index.projectOrder).toEqual(before.projectOrder);
		expect(index.projectOrder).toContain(second.projectId);
		expect(index.organization).toEqual(before.organization);
		expect(updated.directoryIdentity).toEqual(project.directoryIdentity);
		expect(updated.metadataRevision).toBe((project.metadataRevision ?? 0) + 1);
		expect((await loadSavedProjectStateById(project.projectId))?.revision).toBe(oldRevision);
		const renamedGroup = await updateProjectOrganization({
			expectedRevision: index.organization?.revision ?? 0,
			command: { type: "rename", groupId, name: "Team" },
		});
		expect(renamedGroup.ok).toBe(true);
		expect((await readProjectIndex()).version).toBe(3);
		const reset = await updateProjectIndexMetadata({ projectId: project.projectId, displayName: null });
		expect(reset.displayName).toBeUndefined();
		expect(deriveProjectSummary({ ...reset, board: board(movedPath), boardRevision: oldRevision ?? 0 }).name).toBe(
			"renamed",
		);
	});

	it("rejects stale and duplicate locations before writing the index", async () => {
		const project = await createProject("first");
		const second = await createProject("second");
		const before = await readFile(getProjectIndexPath(), "utf8");
		await expect(
			updateProjectIndexMetadata({
				projectId: project.projectId,
				expectedPath: second.repoPath,
				displayName: "Stale",
			}),
		).rejects.toThrow("changed in another window");
		await expect(
			updateProjectIndexMetadata({
				projectId: project.projectId,
				expectedPath: project.repoPath,
				repoPath: second.repoPath,
			}),
		).rejects.toThrow("already registered");
		expect(await readFile(getProjectIndexPath(), "utf8")).toBe(before);
		const attempts = await Promise.allSettled(
			["moved-a", "moved-b"].map((name) =>
				updateProjectIndexMetadata({
					projectId: project.projectId,
					expectedPath: project.repoPath,
					repoPath: join(root.path, name),
				}),
			),
		);
		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
	});

	it("preserves version 3 metadata through backup restore and rejects unfinished relocation snapshots", async () => {
		const project = await createProject("backup-project");
		await updateProjectIndexMetadata({ projectId: project.projectId, displayName: "Retained name" });
		const original = await readProjectIndex();
		const backup = await createBackup();
		if (!backup) throw new Error("Expected a project backup");
		await updateProjectIndexMetadata({ projectId: project.projectId, displayName: "Later name" });
		await restoreBackup(backup);
		expect(await readProjectIndex()).toEqual(original);
		const plan: ProjectRelocationPlan = {
			operationId: randomUUID(),
			projectId: project.projectId,
			oldPath: project.repoPath,
			newPath: join(root.path, "pending"),
			kind: "rename",
			folderOnly: true,
			directoryIdentity: project.directoryIdentity ?? { device: "1", inode: "1" },
			worktrees: [],
			taskWorkingDirectories: {},
		};
		await writeProjectRelocationJournal(plan, "prepared");
		await expect(createBackup()).rejects.toThrow("relocation awaiting recovery");
		await expect(restoreBackup(backup)).rejects.toThrow("relocation awaiting recovery");
		expect(await readProjectIndex()).toEqual(original);
		await finalizeProjectRelocation(plan);
	});
});
