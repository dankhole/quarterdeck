import type { Command } from "commander";
import { withRuntimeMaintenance } from "../server/runtime-ownership.js";
import { acknowledgeRuntimeRecovery, inspectRuntimeRecovery } from "../server/runtime-recovery-acknowledgement.js";
import { getRuntimeHomePath } from "../state/project-state-utils.js";

export function registerRecoverCommand(program: Command): void {
	program
		.command("recover")
		.description("Check prior process evidence after an unconfirmed shutdown.")
		.option(
			"--confirm-stopped",
			"Confirm you checked and stopped any remaining agents or detached background commands.",
		)
		.action(async (options: { confirmStopped?: boolean }) => {
			try {
				await withRuntimeMaintenance(getRuntimeHomePath(), async (lease) => {
					const inspection = await inspectRuntimeRecovery(lease);
					if (!inspection.recoveryRequired) {
						console.log("No recovery confirmation is needed. Reopen Quarterdeck.");
						return;
					}
					if (!options.confirmStopped) {
						console.log(
							"No saved task processes are running. Prior runs did not retain enough evidence to verify detached background commands.\n" +
								"Check and stop any remaining agents or commands, then run:\n" +
								"  quarterdeck recover --confirm-stopped\n" +
								"Saved projects, task work, and session history will be preserved. No processes will be killed.",
						);
						return;
					}
					await acknowledgeRuntimeRecovery(lease);
					console.log(
						"Recovery confirmation recorded. Reopen Quarterdeck; saved projects and sessions are preserved.",
					);
				});
			} catch (error) {
				console.error(
					`Recovery blocked: ${error instanceof Error ? error.message : "Could not verify prior processes."}`,
				);
				process.exitCode = 1;
			}
		});
}
