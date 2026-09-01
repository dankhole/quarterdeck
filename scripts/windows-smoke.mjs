import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

if (process.platform !== "win32") {
	console.error("The native Windows smoke must run on Windows.");
	process.exitCode = 1;
} else {
	const repoRoot = resolve(import.meta.dirname, "..");
	const vitestEntrypoint = resolve(repoRoot, "node_modules", "vitest", "vitest.mjs");
	const commands = [
		[process.execPath, [resolve(import.meta.dirname, "package-artifact-smoke.mjs")]],
		[
			process.execPath,
			[
				vitestEntrypoint,
				"run",
				"test/integration/windows-native-smoke.integration.test.ts",
				"test/integration/cli-parent-disconnect.integration.test.ts",
			],
		],
	];

	for (const [command, args] of commands) {
		const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", windowsHide: true });
		if (result.error) {
			console.error(result.error.message);
			process.exitCode = 1;
			break;
		}
		if (result.status !== 0) {
			process.exitCode = result.status ?? 1;
			break;
		}
	}
}
