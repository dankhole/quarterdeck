process.stdout.write("Synthetic private stdout must not reach the startup surface.\n");
process.stderr.write("Synthetic private stderr must not reach the startup surface.\n");
if (process.env.DESKTOP_RECOVERY_FIXTURE_MODE === "timeout") {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else {
	process.exitCode = process.env.DESKTOP_RECOVERY_FIXTURE_MODE === "failed" ? 1 : 0;
}
