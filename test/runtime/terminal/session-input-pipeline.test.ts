import { describe, expect, it, vi } from "vitest";

import type { PtySession } from "../../../src/terminal/pty-session";
import { isTerminalPassiveMouseReport, processSessionInput } from "../../../src/terminal/session-input-pipeline";
import { createActiveProcessState, createProcessEntry } from "../../../src/terminal/session-manager-types";
import {
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

const SGR_WHEEL = "\u001b[<64;10;5M";
const SGR_MOTION = "\u001b[<35;12;6M";
const X10_WHEEL = "\u001b[M`!!";
const BATCH = Buffer.from(SGR_WHEEL.repeat(12));

function fixture() {
	const write = vi.fn();
	const wasInterrupted = vi.fn(() => false);
	const session = { write, wasInterrupted } as unknown as PtySession;
	const entry = createProcessEntry("task-1");
	entry.active = createActiveProcessState({
		session,
		sessionInstanceId: "launch-1",
		agentId: "codex",
		cols: 80,
		rows: 24,
		willAutoTrust: true,
	});
	const summary = createTestTaskSessionSummary({
		agentId: "codex",
		state: "awaiting_review",
		outstandingInteraction: createTestTaskOutstandingInteraction({ provider: "codex", kind: "permission" }),
	});
	const deps = {
		getSummary: vi.fn(() => summary),
		getEntry: () => entry,
		applyTransitionEvent: vi.fn(() => null),
	};
	return { entry, write, wasInterrupted, summary, deps };
}

describe("passive terminal mouse frame classification", () => {
	it.each([
		SGR_WHEEL,
		SGR_MOTION,
		"\u001b[<95;100;200M",
		X10_WHEEL,
		"\u001b[MC!!",
		SGR_WHEEL.repeat(40),
		X10_WHEEL.repeat(40),
		SGR_WHEEL + X10_WHEEL + SGR_MOTION,
	])("accepts complete passive reports: %j", (data) => {
		expect(isTerminalPassiveMouseReport(Buffer.from(data))).toBe(true);
	});

	it.each([
		"",
		"\u001b[<0;10;5M",
		"\u001b[<0;10;5m",
		"\u001b[M !!",
		`${SGR_WHEEL}\u001b[<0;10;5M`,
		`\u001b[<0;10;5M${SGR_WHEEL}`,
		`${SGR_WHEEL}\r`,
		`y${SGR_WHEEL}`,
		`${SGR_WHEEL}\u0003`,
		`${SGR_WHEEL}\u001b[I`,
		`\u001b[I${SGR_WHEEL}`,
		`${SGR_WHEEL}\u001b[1;2R`,
		`${SGR_WHEEL}\u001b[<64;10;`,
		`${SGR_WHEEL}\u001b[M\`!`,
		"\u001b[<64;;M",
		"\u001b[M\u0000\u0000\u0000",
		"\u001b[<64;;5M",
		"\u001b[<64;10;M",
		"\u001b[<;10;5M",
		"\u001b[<64;10;5;1M",
		"\u001b[<64;10;5m",
		"\u001b[<96;10;5M",
		"\u001b[<64;9007199254740992;5M",
		"\u001b[<64;10;9007199254740992M",
		"\u001b[<4294967360;10;5M",
		"\u001b[<9999999999999999999999;10;5M",
		"\u001b[M\u001f!!",
		"\u001b[M`\u0003!",
	])("rejects mixed, partial, click, or malformed frames: %j", (data) => {
		expect(isTerminalPassiveMouseReport(Buffer.from(data))).toBe(false);
	});
});

describe("passive mouse input pipeline", () => {
	it("writes a batch unchanged before obtaining its only return summary, without evaluating interaction state", () => {
		const test = fixture();
		const interaction = test.summary.outstandingInteraction;
		const readInteraction = vi.fn(() => interaction);
		Object.defineProperty(test.summary, "outstandingInteraction", { get: readInteraction });
		test.deps.getSummary.mockImplementation(() => {
			expect(test.write).toHaveBeenCalledOnce();
			return test.summary;
		});
		expect(processSessionInput(test.entry, test.entry.taskId, BATCH, test.deps)).toBe(test.summary);
		expect(test.write).toHaveBeenCalledExactlyOnceWith(BATCH);
		expect(test.write.mock.calls[0]?.[0]).toBe(BATCH);
		expect(test.deps.getSummary).toHaveBeenCalledOnce();
		expect(readInteraction).not.toHaveBeenCalled();
		expect(test.deps.applyTransitionEvent).not.toHaveBeenCalled();
		expect(test.entry.suppressAutoRestartOnExit).toBe(false);
	});

	it("keeps explicit submission semantics even for mouse-shaped bytes", () => {
		const test = fixture();
		processSessionInput(test.entry, test.entry.taskId, BATCH, test.deps, { explicitUserSubmission: true });
		expect(test.write).toHaveBeenCalledExactlyOnceWith(BATCH);
		expect(test.deps.applyTransitionEvent).toHaveBeenCalledWith(
			test.entry,
			expect.objectContaining({
				type: "interaction.response_submitted",
				responseKind: "submit",
			}),
		);
	});

	it.each(["stopping", "processless"])("does not write passive batches to a %s session", (kind) => {
		const test = fixture();
		if (kind === "stopping") test.wasInterrupted.mockReturnValue(true);
		else test.entry.active = null;
		expect(processSessionInput(test.entry, test.entry.taskId, BATCH, test.deps)).toBeNull();
		expect(test.write).not.toHaveBeenCalled();
		expect(test.deps.getSummary).not.toHaveBeenCalled();
	});

	it("propagates a failed write without claiming a response or reading a return snapshot", () => {
		const test = fixture();
		test.write.mockImplementation(() => {
			throw new Error("write failed");
		});
		expect(() => processSessionInput(test.entry, test.entry.taskId, BATCH, test.deps)).toThrow("write failed");
		expect(test.deps.getSummary).not.toHaveBeenCalled();
		expect(test.deps.applyTransitionEvent).not.toHaveBeenCalled();
	});
});
