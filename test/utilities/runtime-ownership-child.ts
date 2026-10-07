import { acquireRuntimeOwnership } from "../../src/server/runtime-ownership.js";

const stateHome = process.env.QUARTERDECK_TEST_OWNERSHIP_HOME;
if (!stateHome || !process.send) throw new Error("Ownership fixture requires an isolated state home and IPC.");
const lifetime = setTimeout(() => process.exit(2), 20_000);
const admission = await acquireRuntimeOwnership({ stateHome, quarterdeckVersion: "ownership-fixture" });
process.send({
	kind: admission.kind,
	generation: admission.kind === "acquired" ? admission.lease.generation : admission.owner.claim.generation,
});
if (admission.kind === "occupied") {
	clearTimeout(lifetime);
	process.exit(0);
} else {
	process.on("message", async (message: unknown) => {
		if (message === "release") {
			await admission.lease.release();
			process.send?.({ kind: "released" });
		}
		if (message === "exit") {
			clearTimeout(lifetime);
			process.exit(0);
		}
	});
}
