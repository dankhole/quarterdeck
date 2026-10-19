import { fstatSync, statSync } from "node:fs";

if (process.env.QUARTERDECK_INSTALLATION_LOCK_FD !== undefined) {
	const inherited = fstatSync(Number(process.env.QUARTERDECK_INSTALLATION_LOCK_FD));
	const expected = statSync(process.env.QUARTERDECK_INSTALLATION_LOCK_PATH);
	if (inherited.ino !== expected.ino || inherited.dev !== expected.dev) process.exit(7);
}

process.stdout.write("Synthetic private stdout must not reach the startup surface.\n");
process.stderr.write("Synthetic private stderr must not reach the startup surface.\n");
if (process.env.DESKTOP_RECOVERY_FIXTURE_MODE === "timeout") {
	process.on("SIGTERM", () => {});
	process.send?.("ready");
	setInterval(() => {}, 1000);
} else {
	process.exitCode = process.env.DESKTOP_RECOVERY_FIXTURE_MODE === "failed" ? 1 : 0;
}
