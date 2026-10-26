import childProcess from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import initialize from "./quarterdeck-lifecycle.mjs";

// Match Pi's host behavior: report/catch extension errors, await shutdown,
// then exit explicitly. No provider, runtime, PTY or active state is involved.
let spawned = 0;
childProcess.spawn = () => {
	spawned += 1;
	throw new Error("The reliable Pi fixture must not launch a hook child.");
};
syncBuiltinESMExports();
const handlers = new Map();
const listeners = new Map();
const bus = {
	on(name, handler) {
		const entries = listeners.get(name) ?? new Set();
		entries.add(handler);
		listeners.set(name, entries);
		return () => entries.delete(handler);
	},
	emit(name, payload) {
		for (const handler of listeners.get(name) ?? []) handler(payload);
	},
};
initialize({ on: (name, handler) => handlers.set(name, handler), events: bus });
const context = {
	ui: { notify() {} },
	sessionManager: {
		getSessionId: () => "synthetic-pi-session",
		getSessionFile: () => "/synthetic/private-session.jsonl",
	},
	isIdle: () => true,
};
const mode = process.argv[2];
let swallowed = 0;
let expectedRecords = 0;
if (mode === "transient") {
	const directory = join(process.env.QUARTERDECK_STATE_HOME, "hook-transition-outbox");
	await mkdir(process.env.QUARTERDECK_STATE_HOME, { recursive: true });
	await writeFile(directory, "synthetic blocked outbox");
	await handlers.get("agent_start")({}, context).catch(() => { swallowed += 1; });
	await rm(directory);
	expectedRecords = 1;
} else {
	await handlers.get("session_start")({}, context);
	await handlers.get("agent_start")({}, context);
	bus.emit("subagent:async-started", { id: "synthetic-child" });
	for (let index = 0; index < 12; index += 1) {
		// Do not await these publications: shutdown must cover queued writes too.
		handlers.get("agent_end")({ messages: [{ role: "assistant", content: "**Synthetic final**\n\n- retained" }] }, context)
			.catch(() => { swallowed += 1; });
	}
	handlers.get("agent_settled")({ aborted: false }, context).catch(() => { swallowed += 1; });
	expectedRecords = 16; // metadata + start + 12 ends + pending + shutdown settlement
}
const shutdown = handlers.get("session_shutdown")({}, context);
const idempotent = shutdown === handlers.get("session_shutdown")({}, context);
let protectedShutdown = true;
await shutdown.catch(() => { protectedShutdown = false; });
console.log(JSON.stringify({ spawned, swallowed, expectedRecords, idempotent, protectedShutdown }));
process.exit(0);
