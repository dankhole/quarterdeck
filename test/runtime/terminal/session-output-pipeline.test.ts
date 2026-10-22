import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PtySession } from "../../../src/terminal/pty-session";
import { createActiveProcessState, createProcessEntry } from "../../../src/terminal/session-manager-types";
import { processTaskSessionOutput } from "../../../src/terminal/session-output-pipeline";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const mirrors: TerminalStateMirror[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const mirror of mirrors.splice(0)) mirror.dispose();
	vi.useRealTimers();
});

describe("task output broadcast ordering", () => {
	it("keeps arrival order when the inspection predicate flips while broadcasts are deferred", async () => {
		let inspect = true;
		const session = { write: vi.fn(), wasInterrupted: vi.fn(() => false) } as unknown as PtySession;
		const entry = createProcessEntry("task-1");
		entry.active = createActiveProcessState({
			session,
			sessionInstanceId: "launch-1",
			agentId: "codex",
			cols: 80,
			rows: 24,
			willAutoTrust: false,
			launch: {
				args: [],
				env: {},
				detectOutputTransition: () => null,
				shouldInspectOutputForTransition: () => inspect,
			},
		});
		const mirror = new TerminalStateMirror(80, 24);
		mirrors.push(mirror);
		entry.terminalStateMirror = mirror;
		const received: string[] = [];
		entry.listeners.set(1, { onOutput: (chunk) => received.push(chunk.toString("utf8")) });
		const summary = createTestTaskSessionSummary({ agentId: "codex", state: "running" });
		const deps = {
			getSummary: vi.fn(() => summary),
			updateStore: vi.fn(() => summary),
			applyTransitionEvent: vi.fn(() => null),
		};
		const output = (data: string) => processTaskSessionOutput(entry, "task-1", Buffer.from(data), deps);

		output("first");
		inspect = false;
		output("second");
		expect(received).toEqual([]);

		const pending = mirror.getSnapshot();
		await vi.advanceTimersByTimeAsync(10);
		await pending;
		expect(received).toEqual(["first", "second"]);

		// Once the deferred queue drains, uninspected output is broadcast immediately.
		output("third");
		expect(received).toEqual(["first", "second", "third"]);
	});
});
