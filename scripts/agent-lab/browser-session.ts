import { spawn } from "node:child_process";
import { join } from "node:path";

const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

export async function closeAgentLabBrowserSession(repoRoot: string, sessionName: string): Promise<void> {
	const browserEntrypoint = join(repoRoot, "scripts", "agent-browser.ts");
	await new Promise<void>((resolveClose) => {
		const child = spawn(process.execPath, ["--import", "tsx", browserEntrypoint, `-s=${sessionName}`, "close"], {
			cwd: repoRoot,
			env: process.env,
			stdio: "ignore",
		});
		let settled = false;
		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			resolveClose();
		};
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			finish();
		}, BROWSER_CLOSE_TIMEOUT_MS);
		timeout.unref();
		child.once("error", finish);
		child.once("exit", finish);
	});
}
