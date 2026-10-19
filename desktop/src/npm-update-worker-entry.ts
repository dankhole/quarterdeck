import { createInterface } from "node:readline";
import { runNpmUpdateWorker } from "./npm-update-worker.js";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
	console.error("A private Quarterdeck update handoff is required.");
	process.exitCode = 1;
} else {
	process.exitCode = await runNpmUpdateWorker(directory);
	if (process.stdin.isTTY) {
		const terminal = createInterface({ input: process.stdin, output: process.stdout });
		await new Promise<void>((resolve) =>
			terminal.question("\nPress Return to close this update window. ", () => resolve()),
		);
		terminal.close();
	}
}
