import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getProjectDirectoryPath,
	getProjectExecutionOwnershipPath,
	getProjectIndexPath,
	getProjectLifecycleOperationsPath,
	getProjectsRootPath,
} from "../../../src/state/project-state-utils";
import { _testing, createBackup, restoreBackup } from "../../../src/state/state-backup";
import { createTempDir } from "../../utilities/temp-dir";

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
const originalBackupHome = process.env.QUARTERDECK_BACKUP_HOME;
let cleanup = () => {};

beforeEach(() => {
	const temp = createTempDir("quarterdeck-ownership-backup-");
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

describe.sequential("state backup execution ownership", () => {
	it("backs up and restores lifecycle and execution-owner journals together", async () => {
		const projectId = "project-1";
		await mkdir(getProjectsRootPath(), { recursive: true });
		await mkdir(getProjectDirectoryPath(projectId), { recursive: true });
		await writeFile(
			getProjectIndexPath(),
			JSON.stringify({ version: 1, entries: { [projectId]: { repoPath: "/synthetic/project" } } }),
			"utf8",
		);
		const lifecycleContent = JSON.stringify({ version: 1, operations: [] });
		const ownershipContent = JSON.stringify({ version: 1, owners: {}, handoffs: [], interactions: [] });
		await writeFile(getProjectLifecycleOperationsPath(projectId), lifecycleContent, "utf8");
		await writeFile(getProjectExecutionOwnershipPath(projectId), ownershipContent, "utf8");

		const backupPath = await createBackup({ trigger: "manual", maxBackups: 2 });
		expect(backupPath).not.toBeNull();
		await rm(getProjectLifecycleOperationsPath(projectId));
		await rm(getProjectExecutionOwnershipPath(projectId));
		await restoreBackup(backupPath as string);

		await expect(readFile(getProjectLifecycleOperationsPath(projectId), "utf8")).resolves.toBe(lifecycleContent);
		await expect(readFile(getProjectExecutionOwnershipPath(projectId), "utf8")).resolves.toBe(ownershipContent);
	});

	it("does not retain coordination journals created after an older snapshot", async () => {
		const projectId = "project-1";
		await mkdir(getProjectsRootPath(), { recursive: true });
		await mkdir(getProjectDirectoryPath(projectId), { recursive: true });
		await writeFile(
			getProjectIndexPath(),
			JSON.stringify({ version: 1, entries: { [projectId]: { repoPath: "/synthetic/project" } } }),
			"utf8",
		);
		const backupPath = await createBackup({ trigger: "manual", maxBackups: 2 });
		expect(backupPath).not.toBeNull();
		await writeFile(
			getProjectLifecycleOperationsPath(projectId),
			JSON.stringify({ version: 1, operations: [] }),
			"utf8",
		);
		await writeFile(
			getProjectExecutionOwnershipPath(projectId),
			JSON.stringify({ version: 1, owners: {}, handoffs: [], interactions: [] }),
			"utf8",
		);

		await restoreBackup(backupPath as string);

		await expect(readFile(getProjectLifecycleOperationsPath(projectId), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(getProjectExecutionOwnershipPath(projectId), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("detects execution-owner-only changes for periodic backups", async () => {
		const projectId = "project-1";
		await mkdir(getProjectsRootPath(), { recursive: true });
		await mkdir(getProjectDirectoryPath(projectId), { recursive: true });
		await writeFile(
			getProjectIndexPath(),
			JSON.stringify({ version: 1, entries: { [projectId]: { repoPath: "/synthetic/project" } } }),
			"utf8",
		);
		await writeFile(
			getProjectExecutionOwnershipPath(projectId),
			JSON.stringify({ version: 1, owners: {}, handoffs: [], interactions: [] }),
			"utf8",
		);
		const before = await _testing.computeStateFingerprint();

		await writeFile(
			getProjectExecutionOwnershipPath(projectId),
			`${JSON.stringify({ version: 1, owners: {}, handoffs: [], interactions: [] }, null, 2)}\n`,
			"utf8",
		);

		await expect(_testing.computeStateFingerprint()).resolves.not.toBe(before);
	});
});
