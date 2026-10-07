import { spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with code ${result.status ?? "unknown"}.`);
	return result;
}
