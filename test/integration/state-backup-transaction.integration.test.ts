import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core";
import { getProjectStateTransactionPath, withProjectStateLock } from "../../src/state/project-state-transaction";
import { getProjectBoardPath, getProjectDirectoryPath, getProjectIndexPath } from "../../src/state/project-state-utils";
import { _testing, createBackup, restoreBackup } from "../../src/state/state-backup";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";

const projectId = "project-1";
const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalBackupHome = process.env.QUARTERDECK_BACKUP_HOME;
let cleanup = () => {};

beforeEach(async () => {
	const temp = createTempDir("quarterdeck-transaction-backup-");
	cleanup = temp.cleanup;
	process.env.QUARTERDECK_STATE_HOME = join(temp.path, "state");
	process.env.QUARTERDECK_BACKUP_HOME = join(temp.path, "backups");
	await mkdir(getProjectDirectoryPath(projectId), { recursive: true });
	await writeFile(
		getProjectIndexPath(),
		JSON.stringify({ version: 1, entries: { [projectId]: { repoPath: "/synthetic/project" } } }),
	);
});

afterEach(() => {
	cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
	if (originalBackupHome === undefined) delete process.env.QUARTERDECK_BACKUP_HOME;
	else process.env.QUARTERDECK_BACKUP_HOME = originalBackupHome;
});

function transaction(revision: number) {
	const board: RuntimeBoardData = {
		columns: [
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt: `Revision ${revision}`,
						baseRef: "main",
						createdAt: 1,
						updatedAt: revision,
					},
				],
			},
		],
		dependencies: [],
	};
	return {
		version: 1,
		board,
		sessions: { "task-1": createTestTaskSessionSummary({ taskId: "task-1", updatedAt: revision }) },
		meta: {
			revision,
			updatedAt: revision,
			recentBoardCommands: [
				{
					commandId: `start-${revision}`,
					fingerprint: "a".repeat(64),
					revision,
					appliedAt: revision,
					acceptedChange: true,
				},
			],
		},
	};
}

async function writePendingTransaction(revision: number) {
	const state = transaction(revision);
	await writeFile(getProjectStateTransactionPath(projectId), JSON.stringify(state));
	return state;
}

async function expectSnapshot(directory: string, state: ReturnType<typeof transaction>): Promise<void> {
	for (const [filename, expected] of Object.entries({
		"board.json": state.board,
		"sessions.json": state.sessions,
		"meta.json": state.meta,
	})) {
		expect(JSON.parse(await readFile(join(directory, filename), "utf8"))).toEqual(expected);
	}
}

describe("state backup transactions", { concurrent: false }, () => {
	it("backs up the complete committed snapshot after an interrupted file installation", async () => {
		await writePendingTransaction(1);
		await withProjectStateLock(projectId, async () => {});
		const committed = await writePendingTransaction(2);
		// Simulate a crash after only the board file has been installed.
		await writeFile(getProjectBoardPath(projectId), JSON.stringify(committed.board));

		const backupPath = await createBackup();
		expect(backupPath).not.toBeNull();
		await expectSnapshot(join(backupPath as string, "projects", projectId), committed);
		await expect(readFile(getProjectStateTransactionPath(projectId))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("clears a newer pending transaction before restoring an older snapshot", async () => {
		const original = await writePendingTransaction(1);
		const backupPath = await createBackup();
		await writePendingTransaction(2);

		await restoreBackup(backupPath as string);
		// A later reader must not replay the superseded pending commit over the restore.
		await withProjectStateLock(projectId, async () => {
			await expectSnapshot(getProjectDirectoryPath(projectId), original);
		});
		await expect(readFile(getProjectStateTransactionPath(projectId))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("detects committed changes even when no state file was installed before interruption", async () => {
		await writePendingTransaction(1);
		const before = await _testing.computeStateFingerprint();
		const committed = await writePendingTransaction(2);

		await expect(_testing.computeStateFingerprint()).resolves.not.toBe(before);
		await expectSnapshot(getProjectDirectoryPath(projectId), committed);
	});
});
