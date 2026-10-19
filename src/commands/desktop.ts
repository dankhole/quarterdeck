import { dirname, resolve } from "node:path";
import { type Command, Option } from "commander";
import {
	ensureDesktopInstallation,
	getDesktopInstallationStatus,
	resolveDesktopInstallationOwner,
	uninstallDesktopInstallation,
} from "../desktop-install/index.js";
import {
	formatLegacyDesktopMigrationGuidance,
	inventoryLegacyDesktopInstallations,
} from "../desktop-install/legacy.js";

interface InstallOptions {
	from?: string;
	replaceOwner?: boolean;
	ownerPackageSlot?: string;
	ownerPrefix?: string;
}

export function registerDesktopCommand(program: Command, version: string): void {
	const desktop = program.command("desktop").description("Manage Quarterdeck's npm-owned macOS app.");
	desktop
		.command("install")
		.description("Complete or repair this CLI's exact macOS app installation without launching it.")
		.option("--from <app-path>", "Import an explicitly selected local .app candidate.")
		.option("--replace-owner", "Explicitly transfer app ownership to this npm prefix or linked checkout.")
		.addOption(new Option("--owner-package-slot <path>").hideHelp())
		.addOption(new Option("--owner-prefix <path>").hideHelp())
		.action(async (options: InstallOptions) => {
			if ((options.ownerPackageSlot === undefined) !== (options.ownerPrefix === undefined)) {
				throw new Error("Local installation requires both the owning package slot and npm prefix.");
			}
			const owner =
				options.ownerPackageSlot !== undefined && options.ownerPrefix !== undefined
					? await resolveDesktopInstallationOwner({
							packageRoot: resolve(dirname(process.argv[1] ?? ""), ".."),
							packageSlot: options.ownerPackageSlot,
							prefix: options.ownerPrefix,
							kind: "link",
						})
					: undefined;
			const installation = await ensureDesktopInstallation({
				version,
				...(options.from !== undefined ? { from: options.from } : {}),
				...(owner ? { owner } : {}),
				...(options.replaceOwner ? { replaceOwner: true } : {}),
				onProgress: (progress) => console.log(progress.message),
			});
			console.log(
				`Installed ${installation.source === "local" ? "local build" : "desktop app"}: ${installation.appPath}`,
			);
			if (installation.cleanupPending)
				console.log("Installation is complete; cleanup remains pending. Repeat desktop install to finish.");
			console.log(
				"Run quarterdeck to open the app. Updates are managed through the owning npm installation or checkout.",
			);
			for (const line of formatLegacyDesktopMigrationGuidance(await inventoryLegacyDesktopInstallations()))
				console.log(line);
		});
	desktop
		.command("status")
		.description("Read app identity, installation ownership, pending work, and recovery guidance.")
		.option("--json", "Print one JSON status object; exit unsuccessfully unless the installation is ready.")
		.action(async (options: { json?: boolean }) => {
			const status = await getDesktopInstallationStatus();
			if (options.json) {
				console.log(JSON.stringify(status));
				if (status.state !== "ready" || status.pending) process.exitCode = 1;
				return;
			}
			console.log(`Desktop installation: ${status.state}${status.pending ? " (pending operation)" : ""}`);
			console.log(status.message);
			if (status.installation) {
				const { installation } = status;
				console.log(`App: ${installation.appPath}`);
				console.log(`Version: ${installation.version}; build: ${installation.buildId}`);
				console.log(`Owner: ${installation.owner.kind} ${installation.owner.packageRoot}`);
				console.log(`npm prefix: ${installation.owner.prefix}`);
			}
			for (const line of formatLegacyDesktopMigrationGuidance(await inventoryLegacyDesktopInstallations()))
				console.log(line);
		});
	desktop
		.command("uninstall")
		.description("Remove this owner's unused app and installation metadata, preserving all user and project data.")
		.action(async () => {
			const result = await uninstallDesktopInstallation();
			console.log(result.message);
			for (const line of formatLegacyDesktopMigrationGuidance(await inventoryLegacyDesktopInstallations()))
				console.log(line);
		});
}
