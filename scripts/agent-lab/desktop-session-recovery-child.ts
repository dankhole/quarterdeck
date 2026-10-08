import { acquireRuntimeOwnership } from "../../src/server/runtime-ownership.js";

const stateHome = process.env.QUARTERDECK_DESKTOP_RECOVERY_SEED_HOME;
if (!stateHome) throw new Error("Desktop recovery fixture requires an isolated state home.");
const admission = await acquireRuntimeOwnership({ stateHome, quarterdeckVersion: "desktop-session-recovery-fixture" });
if (admission.kind !== "acquired") throw new Error("Desktop recovery fixture unexpectedly has an owner.");
admission.lease.markProcessCustodyDirty();
process.stdout.write(`${JSON.stringify(admission.lease.getClaim())}\n`);
// Deliberately retain this synthetic owner's dirty marker and unreleased claim.
// It launches no agents or descendants; process exit precedes desktop admission.
process.exit(0);
