import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getProjectDirectoryPath,
	getProjectIndexPath,
	getProjectLifecycleOperationsPath,
	getProjectsRootPath,
} from "../../src/state/project-state-utils";
import { createBackup, restoreBackup } from "../../src/state/state-backup";
import { createTempDir } from "../utilities/temp-dir";

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalBackupHome = process.env.QUARTERDECK_BACKUP_HOME;
let cleanup = () => {};

beforeEach(() => {
	const temp = createTempDir("quarterdeck-lifecycle-backup-");
	cleanup = temp.cleanup;
	process.env.QUARTERDECK_STATE_HOME = join(temp.path, "state");
	process.env.QUARTERDECK_BACKUP_HOME = join(temp.path, "backups");
});

afterEach(() => {
	cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
	if (originalBackupHome === undefined) delete process.env.QUARTERDECK_BACKUP_HOME;
	else process.env.QUARTERDECK_BACKUP_HOME = originalBackupHome;
});

async function writeProjectIndex(projectId: string): Promise<void> {
	await mkdir(getProjectsRootPath(), { recursive: true });
	await mkdir(getProjectDirectoryPath(projectId), { recursive: true });
	await writeFile(
		getProjectIndexPath(),
		JSON.stringify({ version: 1, entries: { [projectId]: { repoPath: "/synthetic/project" } } }),
		"utf8",
	);
}

describe.sequential("state backup lifecycle operation journal", () => {
	it("backs up and restores the durable lifecycle operation journal", async () => {
		const projectId = "project-1";
		await writeProjectIndex(projectId);
		const lifecycleContent = JSON.stringify({ version: 1, operations: [{ operationId: "operation-1" }] });
		await writeFile(getProjectLifecycleOperationsPath(projectId), lifecycleContent, "utf8");

		const backupPath = await createBackup({ trigger: "manual", maxBackups: 2 });
		expect(backupPath).not.toBeNull();
		await writeFile(
			getProjectLifecycleOperationsPath(projectId),
			JSON.stringify({ version: 1, operations: [{ operationId: "newer-operation" }] }),
			"utf8",
		);

		await restoreBackup(backupPath as string);

		await expect(readFile(getProjectLifecycleOperationsPath(projectId), "utf8")).resolves.toBe(lifecycleContent);
	});

	it("removes a lifecycle journal created after an older snapshot", async () => {
		const projectId = "project-1";
		await writeProjectIndex(projectId);
		const backupPath = await createBackup({ trigger: "manual", maxBackups: 2 });
		expect(backupPath).not.toBeNull();
		await writeFile(
			getProjectLifecycleOperationsPath(projectId),
			JSON.stringify({ version: 1, operations: [{ operationId: "future-operation" }] }),
			"utf8",
		);

		await restoreBackup(backupPath as string);

		await expect(readFile(getProjectLifecycleOperationsPath(projectId), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
