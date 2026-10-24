import { appendFile } from "node:fs/promises";
import type { RuntimeShutdownOutcome } from "../../src/core/api/runtime-shutdown.js";
import { DesktopRuntimeChannel } from "../../src/server/desktop-runtime-channel.js";

const [evidencePath, finalStatus] = process.argv.slice(2);
if (!evidencePath || !["clean", "incomplete", "reject", "unsettled", "clean-unsettled"].includes(finalStatus ?? ""))
	throw new Error("Invalid test fixture.");
const channel = new DesktopRuntimeChannel();
const startup = await channel.startup;
const incomplete: RuntimeShutdownOutcome = {
	status: "incomplete",
	safeToExit: false,
	safeToReleaseOwnership: false,
	reasons: ["deadline"],
};
const completionGate = new Promise<void>((resolve) => {
	process.on("message", (message: unknown) => {
		if (
			typeof message === "object" &&
			message !== null &&
			"type" in message &&
			message.type === "test:release-completion"
		)
			resolve();
	});
	process.once("disconnect", resolve);
});
channel.setShutdownHandler(async () => {
	await appendFile(evidencePath, "completion_started\n");
	await completionGate;
	if (["reject", "unsettled", "clean-unsettled"].includes(finalStatus ?? "")) {
		// Simulate an automatic writer not covered by the shutdown callback.
		setImmediate(() => void appendFile(evidencePath, "automatic_write_settled\n"));
		if (finalStatus === "reject") throw new Error("Synthetic completion rejection.");
		return {
			outcome:
				finalStatus === "clean-unsettled"
					? { status: "clean", safeToExit: true, safeToReleaseOwnership: true }
					: { ...incomplete, reasons: ["quiescence_failed"] },
			persistenceSettled: false,
		};
	}
	await appendFile(evidencePath, "completion_settled\n");
	return {
		outcome:
			finalStatus === "clean"
				? { status: "clean", safeToExit: true, safeToReleaseOwnership: true }
				: { ...incomplete, reasons: ["processes_unconfirmed"] },
		persistenceSettled: true,
	};
});
await channel.ready({
	runtimeOrigin: "http://127.0.0.1:54321",
	runtimeGeneration: startup.startupId,
	instanceId: startup.startupId,
	diagnosticInstanceId: startup.startupId,
	browserProtocolVersion: 4,
	packageVersion: "test",
	desktopBridgeVersion: 1,
	desktopTransportVersion: 1,
	ownership: "owned",
});
