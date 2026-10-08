#!/usr/bin/env node

import { Command } from "commander";

import { runDesktopSmoke } from "./agent-lab/desktop-smoke";
import { DesktopAgentModeSchema } from "./agent-lab/desktop-types";

const program = new Command("agent-desktop").description(
	"Isolated packaged Electron Agent Lab; never attaches to the user's application.",
);

program
	.command("smoke")
	.description("Launch a packaged .app with synthetic state, exercise native/renderer boundaries, and always stop it")
	.requiredOption("--app <path>", "Packaged Quarterdeck .app path")
	.option("--name <name>", "Artifact run name", "desktop-smoke")
	.option("--keep-temp", "Retain synthetic data after cleanup")
	.option("--show-window", "Show and focus the isolated window for explicit native visibility checks")
	.option("--no-agent", "Limit the smoke to startup, shortcuts, window, and renderer lifecycle")
	.option("--npm-launch", "Check typed npm project handoff and installation identity with hidden synthetic state")
	.option("--manual-shells", "Check Home/Detail shell panel lifetime and hidden native close without a task agent")
	.option("--native-experience", "Check keyboard navigation, enlarged text, and visible close/reopen when requested")
	.option(
		"--performance",
		"Run only hidden fake task/browser idle and navigation measurements, without crash/recovery",
	)
	.option("--main-loss", "Verify fake-provider recovery after exact isolated app process loss")
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
			npmLaunch?: boolean;
			manualShells?: boolean;
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
				npmLaunch: options.npmLaunch,
				manualShells: options.manualShells,
				agentMode: DesktopAgentModeSchema.parse(options.provider),
			});
			process.stdout.write(
				options.json
					? `${JSON.stringify(result, null, 2)}\n`
					: `Desktop smoke passed. Evidence: ${result.manifestPath}\n`,
			);
		},
	);

await program.parseAsync().catch((error: unknown) => {
	process.stderr.write(`[agent-desktop] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
