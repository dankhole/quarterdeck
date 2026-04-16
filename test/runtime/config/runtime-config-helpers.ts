import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export function withTemporaryEnv<T>(
	input: {
		home: string;
		pathPrefix?: string;
		replacePath?: boolean;
	},
	run: () => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousPath = process.env.PATH;
	process.env.HOME = input.home;
	process.env.USERPROFILE = input.home;
	if (input.pathPrefix) {
		process.env.PATH = input.replacePath
			? input.pathPrefix
			: previousPath
				? `${input.pathPrefix}${delimiter}${previousPath}`
				: input.pathPrefix;
	}
	return run().finally(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (input.pathPrefix) {
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
		}
	});
}

export function writeFakeCommand(binDir: string, command: string): void {
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		const scriptPath = join(binDir, `${command}.cmd`);
		writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n", "utf8");
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(scriptPath, 0o755);
}

export function createDefaultSavePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: false,
		readyForReviewNotificationsEnabled: true,
		shellAutoRestartEnabled: true,
		showSummaryOnCards: false,
		autoGenerateSummary: false,
		summaryStaleAfterSeconds: 300,
		showTrashWorktreeNotice: true,
		uncommittedChangesOnCardsEnabled: true,
		unmergedChangesIndicatorEnabled: true,
		behindBaseIndicatorEnabled: true,
		skipTaskCheckoutConfirmation: false,
		skipHomeCheckoutConfirmation: false,
		skipCherryPickConfirmation: false,
		audibleNotificationsEnabled: true,
		audibleNotificationVolume: 0.7,
		audibleNotificationEvents: { permission: true, review: true, failure: true },
		audibleNotificationsOnlyWhenHidden: true,
		audibleNotificationSuppressCurrentProject: {
			permission: false,
			review: false,
			failure: false,
		},
		focusedTaskPollMs: 2000,
		backgroundTaskPollMs: 5000,
		homeRepoPollMs: 10000,
		statuslineEnabled: true,
		terminalFontWeight: 325,
		worktreeAddParentGitDir: false,
		worktreeAddQuarterdeckDir: false,
		showRunningTaskEmergencyActions: false,
		eventLogEnabled: false,
		logLevel: "warn",
		defaultBaseRef: "",
		backupIntervalMinutes: 30,
		shortcuts: [],
		pinnedBranches: [],
		promptShortcuts: [],
		hiddenDefaultPromptShortcuts: [],
		...overrides,
	};
}
