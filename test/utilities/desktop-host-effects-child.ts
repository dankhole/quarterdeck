import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { DesktopRuntimeChannel } from "../../src/server/desktop-runtime-channel.js";

const [evidencePath, ownership] = process.argv.slice(2);
if (!evidencePath || (ownership !== "owned" && ownership !== "attached"))
	throw new Error("Invalid host-effect fixture.");
const channel = new DesktopRuntimeChannel();
await channel.startup;
const generation = randomUUID();
await channel.ready({
	runtimeOrigin: "http://127.0.0.1:54321",
	runtimeGeneration: generation,
	instanceId: generation,
	diagnosticInstanceId: generation,
	browserProtocolVersion: 4,
	packageVersion: "test",
	desktopBridgeVersion: 1,
	desktopTransportVersion: 1,
	ownership,
});
const result = await channel.requestHostEffect({ method: "pick-directory" }, generation);
await writeFile(evidencePath, JSON.stringify(result));
process.exit(0);
