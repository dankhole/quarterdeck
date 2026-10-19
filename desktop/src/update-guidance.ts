import type { Clipboard, MessageBoxOptions } from "electron";
import type { DesktopInstallation } from "../../src/desktop-install/index.js";
import { desktopVersionSchema } from "../../src/desktop-install/receipt.js";

export interface DesktopUpdateGuidance {
	message: string;
	detail: string;
	command: string;
}

function shellArgument(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Receipt paths are arguments to fixed commands, never executable receipt data. */
export function desktopUpdateGuidance(
	owner: DesktopInstallation["owner"],
	targetVersion?: string,
): DesktopUpdateGuidance {
	if (owner.kind === "link") {
		const command = `cd ${shellArgument(owner.packageRoot)} && npm run link`;
		return {
			message: "Update from your linked checkout",
			detail: `This app belongs to the local checkout:\n${owner.packageRoot}\n\nQuit Quarterdeck, update that checkout, then rebuild and install it with:\n\n${command}`,
			command,
		};
	}
	const target = targetVersion === undefined ? "latest" : desktopVersionSchema.parse(targetVersion);
	const command = `npm install --global --prefix ${shellArgument(owner.prefix)} quarterdeck@${target}${targetVersion ? " --registry https://registry.npmjs.org --foreground-scripts" : ""}`;
	return {
		message: "Update Quarterdeck with npm",
		detail: `This app belongs to the npm prefix:\n${owner.prefix}\n\nQuit Quarterdeck, then update its owning package with:\n\n${command}\n\nThe explicit prefix selects this installation even when your shell uses another Node installation.`,
		command,
	};
}

export async function showDesktopUpdateGuidance(
	owner: DesktopInstallation["owner"],
	dialogs: { message: (options: MessageBoxOptions) => Promise<number> },
	clipboard: Pick<Clipboard, "writeText">,
): Promise<void> {
	const guidance = desktopUpdateGuidance(owner);
	const choice = await dialogs.message({
		type: "info",
		buttons: ["Done", "Copy Command"],
		defaultId: 0,
		cancelId: 0,
		message: guidance.message,
		detail: guidance.detail,
	});
	if (choice === 1) clipboard.writeText(guidance.command);
}
