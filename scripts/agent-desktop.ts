#!/usr/bin/env node

import { Command } from "commander";

import { runDesktopSmoke } from "./agent-lab/desktop-smoke";
import { DesktopAgentModeSchema } from "./agent-lab/desktop-types";
import { runWindowsNativePaste } from "./agent-lab/desktop-windows-native-paste";

const program = new Command("agent-desktop").description(
	"Isolated packaged Electron Agent Lab; never attaches to the user's application.",
);

program
	.command("smoke")
	.description("Exercise a packaged desktop app with synthetic state and always stop it")
	.requiredOption("--app <path>", "Packaged Quarterdeck .app or Windows application directory")
	.option("--name <name>", "Artifact run name", "desktop-smoke")
	.option("--keep-temp", "Retain synthetic data after cleanup")
	.option("--show-window", "Show and focus the isolated window for explicit native visibility checks")
	.option("--no-agent", "Limit the smoke to startup, shortcuts, window, and renderer lifecycle")
	.option("--npm-launch", "Check typed npm project handoff and installation identity with hidden synthetic state")
	.option("--manual-shells", "Check Home/Detail shell panel lifetime without a task agent")
	.option("--compare-window", "Check an independent hidden read-only Compare window; requires --no-agent")
	.option("--notifications", "Check hidden desktop tone intent, Settings volume, and muted events with a fake task")
	.option("--native-experience", "Check keyboard navigation, enlarged text, and visible close/reopen when requested")
	.option("--performance", "Measure hidden packaged desktop idle CPU/RSS, task navigation and available terminal ACKs")
	.option("--main-loss", "Verify fake-provider recovery after exact isolated app process loss")
	.option("--windows-terminal-focus", "Check hidden Windows terminal focus and PTY input after dismissing Settings")
	.option("--session-recovery", "Check explicit acknowledgement after isolated unclean startup; requires --no-agent")
	.option("--provider <mode>", "Provider mode: fake, real-codex, or real-claude", "fake")
	.option("--json", "Print artifact references as JSON")
	.action(
		async (options: {
			app: string;
			name: string;
			keepTemp?: boolean;
			showWindow?: boolean;
			nativeExperience?: boolean;
			performance?: boolean;
			mainLoss?: boolean;
			sessionRecovery?: boolean;
			windowsTerminalFocus?: boolean;
			npmLaunch?: boolean;
			manualShells?: boolean;
			compareWindow?: boolean;
			notifications?: boolean;
			agent: boolean;
			json?: boolean;
			provider: string;
		}) => {
			const result = await runDesktopSmoke({
				appPath: options.app,
				name: options.name,
				keepTemp: options.keepTemp,
				includeAgent: options.agent,
				showWindow: options.showWindow,
				nativeExperience: options.nativeExperience,
				performance: options.performance,
				mainLoss: options.mainLoss,
				sessionRecovery: options.sessionRecovery,
				windowsTerminalFocus: options.windowsTerminalFocus,
				npmLaunch: options.npmLaunch,
				manualShells: options.manualShells,
				compareWindow: options.compareWindow,
				notifications: options.notifications,
				agentMode: DesktopAgentModeSchema.parse(options.provider),
			});
			process.stdout.write(
				options.json
					? `${JSON.stringify(result, null, 2)}\n`
					: `Desktop smoke passed. Evidence: ${result.manifestPath}\n`,
			);
		},
	);

program
	.command("windows-native-paste")
	.description("Manually verify physical Ctrl+V; never run on a daily-use desktop or in CI")
	.requiredOption("--app <path>", "Fresh local packaged Windows application directory")
	.requiredOption("--disposable-desktop <computer-name>", "Explicitly chosen disposable Windows computer name")
	.action(async (options: { app: string; disposableDesktop: string }) => {
		const manifest = await runWindowsNativePaste(options.app, options.disposableDesktop);
		process.stdout.write(`Physical paste probe passed. Evidence: ${manifest}\n`);
	});

await program.parseAsync().catch((error: unknown) => {
	process.stderr.write(`[agent-desktop] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
