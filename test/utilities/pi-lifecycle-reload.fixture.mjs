import firstInitialize from "./quarterdeck-lifecycle.mjs";
import reloadedInitialize from "./quarterdeck-lifecycle-reloaded.mjs";

// Two independent ESM module URLs establish the cache-clearing boundary without
// adding dynamic imports to the asset or fixture. The replacement factory runs
// only after the first module's shutdown, as in the pinned Pi reload lifecycle.
const first = new Map();
const second = new Map();
const context = {
	ui: { notify() {} },
	sessionManager: {
		getSessionId: () => "synthetic-pi-session",
		getSessionFile: () => "/synthetic/private-session.jsonl",
	},
	isIdle: () => true,
};
const registry = globalThis[Symbol.for("quarterdeck:pi-hook-delivery:v1")];
const state = registry.get(JSON.stringify([
	process.env.QUARTERDECK_HOOK_PROJECT_ID,
	process.env.QUARTERDECK_HOOK_TASK_ID,
	process.env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID,
]));
async function drain() {
	await state.publicationQueue;
	await state.durableHookQueue;
}
firstInitialize({ on: (name, handler) => first.set(name, handler) });
await first.get("agent_start")({}, context);
await first.get("agent_end")({ messages: [{ role: "assistant", content: "Synthetic reply before reload" }] }, context);
await first.get("agent_settled")({ aborted: false }, context);
await drain();
await first.get("session_shutdown")({}, context);
reloadedInitialize({ on: (name, handler) => second.set(name, handler) });
await second.get("session_start")({}, context);
await second.get("agent_start")({}, context);
await drain();
await second.get("session_shutdown")({}, context);
console.log(JSON.stringify({ registrySize: registry.size, handoff: state.deliveryHandedOff, unpublished: state.unpublishedRequests.length }));
process.exit(0);
