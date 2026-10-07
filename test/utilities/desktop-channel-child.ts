import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeShutdownOutcome } from "../../src/core/api/runtime-shutdown.js";
import { DesktopRuntimeChannel } from "../../src/server/desktop-runtime-channel.js";

const [evidencePath, finalStatus] = process.argv.slice(2);
if (!evidencePath || !["clean", "incomplete"].includes(finalStatus ?? "")) throw new Error("Invalid test fixture.");
const channel = new DesktopRuntimeChannel();
const startup = await channel.startup;
const incomplete: RuntimeShutdownOutcome = {
	status: "incomplete",
	safeToExit: false,
	safeToReleaseOwnership: false,
	reasons: ["deadline"],
};
channel.setShutdownHandler(async (waitForCompletion) => {
	await appendFile(evidencePath, `${waitForCompletion ? "completion" : "bounded"}\n`);
	await delay(waitForCompletion ? 75 : 25);
	return waitForCompletion && finalStatus === "clean"
		? { status: "clean", safeToExit: true, safeToReleaseOwnership: true }
		: incomplete;
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
