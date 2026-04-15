import type { Command } from "commander";

import {
	type BackupListEntry,
	createBackup,
	getBackupHomePath,
	listBackups,
	restoreBackup,
} from "../state/state-backup";

function formatBackupRow(entry: BackupListEntry): string {
	const date = new Date(entry.manifest.timestamp).toLocaleString();
	const workspaces = entry.manifest.workspaceIds.length;
	return `  ${entry.name}  ${entry.manifest.trigger.padEnd(8)}  ${String(workspaces).padStart(2)} workspace(s)  ${date}`;
}

export function registerBackupCommand(program: Command): void {
	const backup = program.command("backup").description("Manage state backups.");

	backup
		.command("create")
		.description("Create a state backup snapshot.")
		.action(async () => {
			try {
				const path = await createBackup({ trigger: "manual" });
				if (path) {
					console.log(`Backup created: ${path}`);
				} else {
					console.log("Nothing to back up (no state files found).");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Backup failed: ${message}`);
				process.exitCode = 1;
			}
		});

	backup
		.command("list")
		.description("List available backups.")
		.action(async () => {
			try {
				const backups = await listBackups();
				if (backups.length === 0) {
					console.log(`No backups found in ${getBackupHomePath()}`);
					return;
				}
				console.log(`Backups (${getBackupHomePath()}):\n`);
				for (const entry of backups) {
					console.log(formatBackupRow(entry));
				}
				console.log(`\n${backups.length} backup(s) total.`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Failed to list backups: ${message}`);
				process.exitCode = 1;
			}
		});

	backup
		.command("restore [backup]")
		.description("Restore state from a backup. Specify a backup directory name or path. Server must not be running.")
		.action(async (backupPathOrName?: string) => {
			if (!backupPathOrName) {
				const backups = await listBackups();
				if (backups.length === 0) {
					console.error("No backups available to restore.");
					process.exitCode = 1;
					return;
				}
				backupPathOrName = backups[0]?.name;
				console.log(`No backup specified. Using most recent: ${backupPathOrName}`);
			}

			try {
				const manifest = await restoreBackup(backupPathOrName);
				const date = new Date(manifest.timestamp).toLocaleString();
				console.log(`Restored backup from ${date} (${manifest.workspaceIds.length} workspace(s)).`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Restore failed: ${message}`);
				process.exitCode = 1;
			}
		});
}
