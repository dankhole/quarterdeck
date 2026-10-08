import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireRuntimeOwnership, withRuntimeMaintenance } from "../../src/server/runtime-ownership.js";
import {
	acknowledgeRuntimeRecovery,
	inspectRuntimeRecovery,
} from "../../src/server/runtime-recovery-acknowledgement.js";
import { assertRuntimeRecoveryAdmission } from "../../src/server/runtime-recovery-admission.js";

const stateHome = process.env.QUARTERDECK_TEST_RECOVERY_HOME;
const mode = process.argv[2];
if (!stateHome || !process.send) throw new Error("Recovery fixture requires an isolated home and IPC.");
const lifetime = setTimeout(() => process.exit(2), 20_000);

try {
	if (mode === "acknowledge" || mode === "inspect") {
		const inspection = await withRuntimeMaintenance(stateHome, async (lease) => {
			const result = await inspectRuntimeRecovery(lease);
			if (mode === "acknowledge") await acknowledgeRuntimeRecovery(lease);
			return { ...result, generation: lease.generation, bootIdentity: lease.bootIdentity };
		});
		process.send({ kind: "inspected", ...inspection });
		clearTimeout(lifetime);
		process.disconnect();
	} else {
		const admission = await acquireRuntimeOwnership({ stateHome, quarterdeckVersion: "recovery-fixture" });
		if (admission.kind !== "acquired") throw new Error("Expected an exclusive recovery fixture owner.");
		try {
			await assertRuntimeRecoveryAdmission({
				stateHome,
				currentGeneration: admission.lease.generation,
				bootIdentity: admission.lease.bootIdentity,
			});
		} catch (error) {
			await admission.lease.release();
			throw error;
		}
		if (mode === "dirty-owner") {
			admission.lease.markProcessCustodyDirty();
			const project = join(stateHome, "projects", "synthetic");
			await mkdir(project, { recursive: true });
			await writeFile(join(project, "sessions.json"), JSON.stringify({ synthetic: { pid: process.pid } }));
			process.send({
				kind: "ready",
				generation: admission.lease.generation,
				bootIdentity: admission.lease.bootIdentity,
			});
			// Parent kills this synthetic owner to exercise genuine unreleased custody.
		} else if (mode === "admit") {
			await admission.lease.release();
			process.send({
				kind: "admitted",
				generation: admission.lease.generation,
				bootIdentity: admission.lease.bootIdentity,
			});
			clearTimeout(lifetime);
			process.disconnect();
		} else throw new Error("Unknown recovery fixture mode.");
	}
} catch (error) {
	process.send({
		kind: "denied",
		reason: typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined,
		code: typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
	});
	clearTimeout(lifetime);
	process.disconnect();
}
