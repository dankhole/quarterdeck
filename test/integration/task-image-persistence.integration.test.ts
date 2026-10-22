import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeProjectBoardCommand,
	RuntimeTaskImage,
	RuntimeTaskImageInput,
	RuntimeTaskImageRef,
} from "../../src/core";
import { findCardInBoard } from "../../src/core";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { ProjectTaskLifecycleService } from "../../src/server";
import { ProjectBoardCommandService } from "../../src/state/project-board-command-service";
import {
	applyProjectBoardMutationById,
	loadProjectContext,
	loadSavedProjectStateById,
} from "../../src/state/project-state";
import { getProjectStateTransactionPath } from "../../src/state/project-state-transaction";
import {
	getProjectBoardPath,
	getProjectDirectoryPath,
	getProjectLifecycleOperationsPath,
	getProjectMetaPath,
	getProjectSessionsPath,
} from "../../src/state/project-state-utils";
import { ProjectTaskLifecycleOperationStore } from "../../src/state/project-task-lifecycle-operation-store";
import { createBackup, restoreBackup } from "../../src/state/state-backup";
import { LEGACY_IMAGE_MIGRATION_INITIAL_BACKOFF_MS } from "../../src/state/task-image-maintenance";
import { getProjectTaskImagesPath, TASK_IMAGE_GC_GRACE_MS } from "../../src/state/task-image-store";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalBackupHome = process.env.QUARTERDECK_BACKUP_HOME;
let fixture: ReturnType<typeof createTempDir>;
let scope: { projectId: string; projectPath: string };
let service: ProjectBoardCommandService;
let commandCount = 0;

function inlineImage(id: string, content: string): RuntimeTaskImage {
	return { id, name: `${id}.png`, mimeType: "image/png", data: Buffer.from(content).toString("base64") };
}

function sha256(content: string): string {
	return createHash("sha256").update(Buffer.from(content)).digest("hex");
}

function refFor(id: string, content: string): RuntimeTaskImageRef {
	return { id, name: `${id}.png`, mimeType: "image/png", sha256: sha256(content), byteLength: content.length };
}

function readRawBoard(): string {
	return readFileSync(getProjectBoardPath(scope.projectId), "utf8");
}

function storedBlobs(): string[] {
	const directory = getProjectTaskImagesPath(scope.projectId);
	return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function ageBlobs(): void {
	const old = new Date(Date.now() - TASK_IMAGE_GC_GRACE_MS - 60_000);
	for (const blob of storedBlobs()) utimesSync(join(getProjectTaskImagesPath(scope.projectId), blob), old, old);
}

async function currentRevision(): Promise<number> {
	return (await loadSavedProjectStateById(scope.projectId))?.revision ?? 0;
}

async function run(command: RuntimeProjectBoardCommand, commandId = `command-${++commandCount}`) {
	return await service.execute(scope, { commandId, expectedRevision: await currentRevision(), command });
}

function createTask(taskId: string, images: RuntimeTaskImageInput[]): RuntimeProjectBoardCommand {
	return {
		kind: "create_task",
		columnId: "review",
		taskId,
		prompt: `Prompt ${taskId}`,
		images,
		baseRef: "main",
		createdAt: 100,
	};
}

function legacyBoard(images: RuntimeTaskImage[]) {
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{ id: "legacy", title: null, prompt: "Legacy", images, baseRef: "main", createdAt: 1, updatedAt: 1 },
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
	};
}

beforeEach(async () => {
	fixture = createTempDir("quarterdeck-task-image-persistence-");
	process.env.QUARTERDECK_STATE_HOME = join(fixture.path, "state");
	process.env.QUARTERDECK_BACKUP_HOME = join(fixture.path, "backups");
	const projectPath = join(fixture.path, "project");
	mkdirSync(projectPath);
	const context = await loadProjectContext(projectPath, { folderOnly: true });
	scope = { projectId: context.projectId, projectPath: context.repoPath };
	service = new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	fixture.cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
	if (originalBackupHome === undefined) delete process.env.QUARTERDECK_BACKUP_HOME;
	else process.env.QUARTERDECK_BACKUP_HOME = originalBackupHome;
});

describe("task image persistence", () => {
	it("commits uploads as references and replays the same command by its original fingerprint", async () => {
		const upload = inlineImage("img-a", "alpha");
		const command = createTask("task-a", [upload]);
		const created = await run(command, "create-a");
		expect(findCardInBoard(created.state.board, "task-a")?.images).toEqual([refFor("img-a", "alpha")]);
		expect(readRawBoard()).not.toContain(upload.data);
		expect(readRawBoard()).toContain(sha256("alpha"));
		expect(storedBlobs()).toEqual([sha256("alpha")]);

		const replay = await service.execute(scope, {
			commandId: "create-a",
			expectedRevision: created.state.revision,
			command,
		});
		expect(replay).toMatchObject({
			replayed: true,
			acceptedChange: true,
			state: { revision: created.state.revision },
		});
	});

	it("keeps stored references on edit, stores new uploads, and rejects unknown references", async () => {
		await run(createTask("task-a", [inlineImage("img-a", "alpha")]));
		const edited = await run({
			kind: "update_task",
			taskId: "task-a",
			prompt: "Edited",
			images: [refFor("img-a", "alpha"), inlineImage("img-b", "beta")],
			baseRef: "main",
			updatedAt: 200,
		});
		expect(findCardInBoard(edited.state.board, "task-a")?.images).toEqual([
			refFor("img-a", "alpha"),
			refFor("img-b", "beta"),
		]);
		expect(storedBlobs()).toEqual([sha256("alpha"), sha256("beta")].sort());

		const before = readRawBoard();
		await expect(
			run({
				kind: "update_task",
				taskId: "task-a",
				prompt: "Edited again",
				images: [refFor("img-c", "never stored")],
				baseRef: "main",
				updatedAt: 300,
			}),
		).rejects.toThrow("no longer available");
		expect(readRawBoard()).toBe(before);
	});

	it("collects blobs on permanent delete only after the last card, including Trash, drops them", async () => {
		await run(createTask("task-a", [inlineImage("img-a", "shared"), inlineImage("img-u", "unique")]));
		await run(createTask("task-b", [inlineImage("img-b", "shared")]));
		await run({ kind: "move_task", taskId: "task-b", targetColumnId: "trash", updatedAt: 200 });
		ageBlobs();

		await run({ kind: "move_task", taskId: "task-a", targetColumnId: "trash", updatedAt: 300 });
		expect(storedBlobs()).toEqual([sha256("shared"), sha256("unique")].sort());

		await run({ kind: "delete_tasks", taskIds: ["task-a"] });
		expect(storedBlobs()).toEqual([sha256("shared")]);

		await run({ kind: "delete_tasks", taskIds: ["task-b"] });
		expect(storedBlobs()).toEqual([]);
	});

	it("publishes legacy inline boards as references without writing, then migrates on the next runtime write", async () => {
		const upload = inlineImage("img-legacy", "legacy-bytes");
		mkdirSync(getProjectDirectoryPath(scope.projectId), { recursive: true });
		writeFileSync(getProjectBoardPath(scope.projectId), JSON.stringify(legacyBoard([upload])));
		writeFileSync(getProjectMetaPath(scope.projectId), JSON.stringify({ revision: 7, updatedAt: 1 }));
		const legacyRaw = readRawBoard();

		const read = await loadSavedProjectStateById(scope.projectId);
		expect(findCardInBoard(read?.board ?? { columns: [] }, "legacy")?.images).toEqual([
			refFor("img-legacy", "legacy-bytes"),
		]);
		expect(readRawBoard()).toBe(legacyRaw);
		expect(storedBlobs()).toEqual([]);

		// Hook-driven session saves never change the board; they still perform the one-time migration.
		const sessions = { legacy: createTestTaskSessionSummary({ taskId: "legacy" }) };
		const saved = await applyProjectBoardMutationById(scope.projectId, {
			sessions,
			persistSessionsOnNoop: true,
			mutate: (board) => ({ board, changed: false }),
		});
		expect(saved.state.revision).toBe(7);
		expect(readRawBoard()).not.toContain(upload.data);
		expect(storedBlobs()).toEqual([sha256("legacy-bytes")]);
		expect(JSON.parse(readFileSync(getProjectMetaPath(scope.projectId), "utf8"))).toMatchObject({ revision: 7 });
		expect(findCardInBoard(saved.state.board, "legacy")?.images).toEqual([refFor("img-legacy", "legacy-bytes")]);
	});

	it("recovers a pending legacy journal with inline images before externalizing them", async () => {
		const upload = inlineImage("img-journal", "journal-bytes");
		mkdirSync(getProjectDirectoryPath(scope.projectId), { recursive: true });
		writeFileSync(
			getProjectStateTransactionPath(scope.projectId),
			JSON.stringify({
				version: 1,
				board: legacyBoard([upload]),
				sessions: {},
				meta: { revision: 3, updatedAt: 1, recentBoardCommands: [] },
			}),
		);

		const recovered = await loadSavedProjectStateById(scope.projectId);
		expect(recovered?.revision).toBe(3);
		expect(findCardInBoard(recovered?.board ?? { columns: [] }, "legacy")?.images).toEqual([
			refFor("img-journal", "journal-bytes"),
		]);
		expect(existsSync(getProjectStateTransactionPath(scope.projectId))).toBe(false);
		expect(readRawBoard()).toContain(upload.data);

		await run({ kind: "patch_task", taskId: "legacy", title: "Renamed", updatedAt: 5 });
		expect(readRawBoard()).not.toContain(upload.data);
		expect(storedBlobs()).toEqual([sha256("journal-bytes")]);
	});

	it("resolves stored references into launch input", async () => {
		const created = await run(createTask("task-a", [inlineImage("img-a", "launch-bytes")]));
		const startTaskSession = async () => ({
			ok: true,
			summary: createTestTaskSessionSummary({ taskId: "task-a", state: "running" }),
		});
		const calls: unknown[] = [];
		const lifecycle = new ProjectTaskLifecycleService({
			boardCommands: service,
			startTaskSession: async (_scope, request) => {
				calls.push(request);
				return await startTaskSession();
			},
		});
		const started = await lifecycle.execute(scope, {
			kind: "start",
			operationId: "start-a",
			taskId: "task-a",
			taskCreatedAt: 100,
			expectedRevision: created.state.revision,
		});
		expect(started.ok).toBe(true);
		expect(calls).toEqual([
			expect.objectContaining({ images: [inlineImage("img-a", "launch-bytes")], prompt: "Prompt task-a" }),
		]);
	});

	it("hard-links blobs into backups and restores them before the board", async () => {
		await run(createTask("task-a", [inlineImage("img-a", "backup-bytes")]));
		const blob = sha256("backup-bytes");
		const backupDir = await createBackup({ trigger: "manual" });
		expect(backupDir).not.toBeNull();
		const backupBlob = join(backupDir ?? "", "projects", scope.projectId, "images", blob);
		const liveBlob = join(getProjectTaskImagesPath(scope.projectId), blob);
		if (process.platform !== "win32") expect(statSync(backupBlob).ino).toBe(statSync(liveBlob).ino);

		rmSync(getProjectTaskImagesPath(scope.projectId), { recursive: true });
		await restoreBackup(backupDir ?? "");
		expect(readFileSync(liveBlob, "utf8")).toBe("backup-bytes");
	});

	it("keeps image bytes in pending lifecycle operations and strips them once terminal", async () => {
		const upload = inlineImage("img-op", "operation-bytes");
		const command = {
			kind: "create_and_start" as const,
			operationId: "create-start-op",
			expectedRevision: 0,
			startedAt: 150,
			task: { taskId: "task-op", prompt: "Prompt task-op", images: [upload], baseRef: "main", createdAt: 100 },
		};
		const store = new ProjectTaskLifecycleOperationStore();
		const journalText = () => readFileSync(getProjectLifecycleOperationsPath(scope.projectId), "utf8");

		await store.begin(scope, command);
		// Crash recovery replays the pending command; its fingerprints depend on the exact bytes.
		expect(journalText()).toContain(upload.data);

		await store.update(scope, command.operationId, (current) => ({
			...current,
			status: "completed",
			phase: "finished",
			completedAt: Date.now(),
		}));
		expect(journalText()).not.toContain(upload.data);
		const retained = await store.get(scope, command.operationId);
		expect(retained?.command).toMatchObject({ task: { images: [refFor("img-op", "operation-bytes")] } });

		// A retry of the original command still matches the stored fingerprint.
		expect(await store.begin(scope, command)).toMatchObject({ replayed: true, operation: { status: "completed" } });
	});

	it("loads legacy terminal operations with inline images and compacts them on the next write", async () => {
		const upload = inlineImage("img-legacy-op", "legacy-operation-bytes");
		const store = new ProjectTaskLifecycleOperationStore();
		const legacy = {
			kind: "create_and_start" as const,
			operationId: "legacy-op",
			expectedRevision: 0,
			startedAt: 150,
			task: { taskId: "task-legacy", prompt: "Legacy", images: [upload], baseRef: "main", createdAt: 100 },
		};
		await store.begin(scope, legacy);
		const finished = await store.update(scope, legacy.operationId, (current) => ({
			...current,
			status: "failed",
			phase: "finished",
			completedAt: Date.now(),
		}));
		// Simulate a file written by an older runtime that retained the bytes.
		writeFileSync(
			getProjectLifecycleOperationsPath(scope.projectId),
			JSON.stringify({ version: 1, operations: [finished] }),
		);
		expect((await store.get(scope, legacy.operationId))?.status).toBe("failed");

		await store.begin(scope, {
			...legacy,
			operationId: "next-op",
			task: { ...legacy.task, taskId: "task-next", images: [] },
		});
		expect(readFileSync(getProjectLifecycleOperationsPath(scope.projectId), "utf8")).not.toContain(upload.data);
		expect(await store.begin(scope, legacy)).toMatchObject({ replayed: true });
	});
});

describe("task image maintenance", () => {
	function seedLegacyBoard(upload: RuntimeTaskImage, revision = 7): void {
		mkdirSync(getProjectDirectoryPath(scope.projectId), { recursive: true });
		writeFileSync(getProjectBoardPath(scope.projectId), JSON.stringify(legacyBoard([upload])));
		writeFileSync(getProjectMetaPath(scope.projectId), JSON.stringify({ revision, updatedAt: 1 }));
	}

	async function saveSessionsOnly(updatedAt: number) {
		return await applyProjectBoardMutationById(scope.projectId, {
			sessions: { legacy: createTestTaskSessionSummary({ taskId: "legacy", updatedAt }) },
			persistSessionsOnNoop: true,
			mutate: (board) => ({ board, changed: false }),
		});
	}

	function savedSessionUpdatedAt(): number | undefined {
		const sessions = JSON.parse(readFileSync(getProjectSessionsPath(scope.projectId), "utf8")) as Record<
			string,
			{ updatedAt?: number }
		>;
		return sessions.legacy?.updatedAt;
	}

	it("fails a session-only save when a committed migration journal cannot install", async () => {
		const upload = inlineImage("img-install", "install-bytes");
		seedLegacyBoard(upload);
		const boardPath = getProjectBoardPath(scope.projectId);
		const writeJson = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
		const spy = vi
			.spyOn(lockedFileSystem, "writeJsonFileAtomic")
			.mockImplementation(async (path, payload, options) => {
				if (path === boardPath) throw new Error("board install failed");
				await writeJson(path, payload, options);
			});

		// The journal is the commit record: acknowledging these sessions now would let
		// the next lock holder's recovery replace them with the journal's copy.
		await expect(saveSessionsOnly(100)).rejects.toThrow("board install failed");
		expect(existsSync(getProjectStateTransactionPath(scope.projectId))).toBe(true);
		expect(existsSync(getProjectSessionsPath(scope.projectId))).toBe(false);

		spy.mockRestore();
		const saved = await saveSessionsOnly(200);
		expect(saved.state.revision).toBe(7);
		expect(existsSync(getProjectStateTransactionPath(scope.projectId))).toBe(false);
		expect(savedSessionUpdatedAt()).toBe(200);
		expect(readRawBoard()).not.toContain(upload.data);
	});

	it("backs off a failing legacy migration instead of retrying on every write", async () => {
		const upload = inlineImage("img-backoff", "backoff-bytes");
		seedLegacyBoard(upload);
		// A file where the image directory belongs makes every blob write fail.
		const imagesPath = getProjectTaskImagesPath(scope.projectId);
		writeFileSync(imagesPath, "not a directory");

		await saveSessionsOnly(100);
		expect(savedSessionUpdatedAt()).toBe(100);
		expect(readRawBoard()).toContain(upload.data);
		await expect(run({ kind: "patch_task", taskId: "legacy", title: "Renamed", updatedAt: 5 })).rejects.toThrow(
			"could not save an attached image",
		);

		rmSync(imagesPath);
		await saveSessionsOnly(200);
		expect(readRawBoard()).toContain(upload.data);

		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + LEGACY_IMAGE_MIGRATION_INITIAL_BACKOFF_MS + 1_000 });
		await saveSessionsOnly(300);
		expect(readRawBoard()).not.toContain(upload.data);
		expect(storedBlobs()).toEqual([sha256("backoff-bytes")]);
		expect(savedSessionUpdatedAt()).toBe(300);
	});

	it("sweeps orphans on the first runtime write and collects recently dropped blobs after the grace window", async () => {
		const imagesPath = getProjectTaskImagesPath(scope.projectId);
		mkdirSync(imagesPath, { recursive: true });
		const orphan = sha256("orphan-bytes");
		writeFileSync(join(imagesPath, orphan), "orphan-bytes");
		writeFileSync(join(imagesPath, `${orphan}.tmp.1.2.3`), "partial");
		ageBlobs();
		const staleTemp = join(imagesPath, `${orphan}.tmp.1.2.3`);
		utimesSync(staleTemp, new Date(0), new Date(0));

		await run(createTask("task-a", [inlineImage("img-a", "kept-bytes")]));
		expect(storedBlobs()).toEqual([sha256("kept-bytes")]);

		await run(createTask("task-b", [inlineImage("img-b", "dropped-bytes")]));
		await run({ kind: "delete_tasks", taskIds: ["task-b"] });
		await run({ kind: "patch_task", taskId: "task-a", title: "Still young", updatedAt: 300 });
		expect(storedBlobs()).toEqual([sha256("dropped-bytes"), sha256("kept-bytes")].sort());

		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + TASK_IMAGE_GC_GRACE_MS + 1_000 });
		await saveSessionsOnly(400);
		expect(storedBlobs()).toEqual([sha256("kept-bytes")]);
	});

	it("fails a lifecycle create that references an image this project does not store", async () => {
		const startTaskSession = vi.fn();
		const lifecycle = new ProjectTaskLifecycleService({ boardCommands: service, startTaskSession });
		const result = await lifecycle.execute(scope, {
			kind: "create_and_start",
			operationId: "create-missing-image",
			expectedRevision: 0,
			startedAt: 150,
			task: {
				taskId: "task-missing",
				prompt: "Missing image",
				images: [refFor("img-missing", "never stored")],
				baseRef: "main",
				createdAt: 100,
			},
		});
		expect(result).toMatchObject({ ok: false, operation: { outcomeCode: "invalid_transition" } });
		expect(startTaskSession).not.toHaveBeenCalled();
	});
});
