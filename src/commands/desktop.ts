import type { Command } from "commander";
import { ensureDesktopInstallation } from "../desktop-install/index.js";

export function registerDesktopCommand(program: Command, version: string): void {
	const desktop = program.command("desktop").description("Manage the optional macOS app installed by npm.");
	desktop
		.command("install")
		.description("Install this CLI version's macOS app without launching it.")
		.option(
			"--from <app-path>",
			"Import an explicitly selected local .app candidate instead of downloading a release.",
		)
		.action(async (options: { from?: string }) => {
			const installation = await ensureDesktopInstallation({
				version,
				...(options.from !== undefined ? { from: options.from } : {}),
				onProgress: (progress) => console.log(progress.message),
			});
			console.log(
				`Installed ${installation.source === "local" ? "local candidate" : "desktop app"}: ${installation.appPath}`,
			);
			console.log("Quit any running Quarterdeck app before switching installations.");
			console.log("Run quarterdeck --desktop to open it. Desktop updates are managed through npm.");
		});
}
