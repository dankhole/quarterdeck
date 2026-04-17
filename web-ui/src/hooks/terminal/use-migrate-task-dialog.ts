import type { MutableRefObject } from "react";
import { useCallback, useState } from "react";
import { type MigrateDirection, useMigrateWorkingDirectory } from "@/hooks/terminal/use-migrate-working-directory";
import { getDetailTerminalTaskId } from "@/hooks/terminal/use-terminal-panels";

interface UseMigrateTaskDialogInput {
	currentProjectId: string | null;
	serverMutationInFlightRef: MutableRefObject<boolean>;
	stopTaskSession: (taskId: string) => Promise<void>;
	refreshProjectState: () => Promise<void>;
}

interface UseMigrateTaskDialogResult {
	pendingMigrate: { taskId: string; direction: MigrateDirection } | null;
	migratingTaskId: string | null;
	handleMigrateWorkingDirectory: (taskId: string, direction: MigrateDirection) => void;
	handleConfirmMigrate: () => void;
	cancelMigrate: () => void;
}

/**
 * Wraps `useMigrateWorkingDirectory` with dialog confirmation state.
 * The user triggers `handleMigrateWorkingDirectory` which opens a confirmation dialog,
 * then `handleConfirmMigrate` executes the actual migration.
 */
export function useMigrateTaskDialog({
	currentProjectId,
	serverMutationInFlightRef,
	stopTaskSession,
	refreshProjectState,
}: UseMigrateTaskDialogInput): UseMigrateTaskDialogResult {
	const { migrate: migrateWorkingDirectory, migratingTaskId } = useMigrateWorkingDirectory(currentProjectId);
	const [pendingMigrate, setPendingMigrate] = useState<{
		taskId: string;
		direction: MigrateDirection;
	} | null>(null);

	const handleMigrateWorkingDirectory = useCallback((taskId: string, direction: MigrateDirection) => {
		setPendingMigrate({ taskId, direction });
	}, []);

	const handleConfirmMigrate = useCallback(() => {
		if (pendingMigrate) {
			serverMutationInFlightRef.current = true;
			void migrateWorkingDirectory(pendingMigrate.taskId, pendingMigrate.direction).finally(() => {
				serverMutationInFlightRef.current = false;
				// Stop any open detail shell for this task so the next open
				// spawns in the new working directory.
				void stopTaskSession(getDetailTerminalTaskId(pendingMigrate.taskId));
				void refreshProjectState();
			});
			setPendingMigrate(null);
		}
	}, [pendingMigrate, migrateWorkingDirectory, refreshProjectState, stopTaskSession, serverMutationInFlightRef]);

	const cancelMigrate = useCallback(() => setPendingMigrate(null), []);

	return {
		pendingMigrate,
		migratingTaskId,
		handleMigrateWorkingDirectory,
		handleConfirmMigrate,
		cancelMigrate,
	};
}
