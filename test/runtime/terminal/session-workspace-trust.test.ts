import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAgentId } from "../../../src/core";
import { WORKSPACE_TRUST_CONFIRM_DELAY_MS } from "../../../src/terminal/claude-workspace-trust";
import type { PtySession } from "../../../src/terminal/pty-session";
import { processSessionInput } from "../../../src/terminal/session-input-pipeline";
import {
	createActiveProcessState,
	createProcessEntry,
	type ProcessEntry,
} from "../../../src/terminal/session-manager-types";
import { processShellSessionOutput, processTaskSessionOutput } from "../../../src/terminal/session-output-pipeline";
import { processWorkspaceTrustOutput } from "../../../src/terminal/session-workspace-trust";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";
import {
	MODERN_CODEX_TRUST_DISCLOSURE,
	MODERN_CODEX_TRUST_RENDER_ANSI,
	renderModernCodexTrustANSI,
} from "./codex-workspace-trust-fixtures";

const CLEAR = "\u001b[2J\u001b[H› ";
const entries: ProcessEntry[] = [];

function fixture(agentId: RuntimeAgentId | null = "codex", willAutoTrust = true) {
	const write = vi.fn();
	const session = { write, wasInterrupted: vi.fn(() => false) } as unknown as PtySession;
	const entry = createProcessEntry("task-1");
	entry.active = createActiveProcessState({
		session,
		sessionInstanceId: "launch-1",
		agentId,
		cols: 80,
		rows: 40,
		willAutoTrust,
	});
	entry.terminalStateMirror = new TerminalStateMirror(80, 40);
	entries.push(entry);
	const summary = createTestTaskSessionSummary({
		taskId: entry.taskId,
		agentId,
		sessionInstanceId: "launch-1",
		state: "awaiting_review",
		reviewReason: "unconfirmed",
	});
	const deps = {
		getSummary: vi.fn(() => summary),
		updateStore: vi.fn(() => summary),
		applyTransitionEvent: vi.fn(() => null),
	};
	return { entry, active: entry.active, write, deps, summary };
}

function output(test: ReturnType<typeof fixture>, data = MODERN_CODEX_TRUST_RENDER_ANSI) {
	processTaskSessionOutput(test.entry, test.entry.taskId, Buffer.from(data), test.deps);
}

async function flushMirror(test: ReturnType<typeof fixture>) {
	const pending = test.entry.terminalStateMirror?.getSnapshot();
	await vi.advanceTimersByTimeAsync(10);
	await pending;
}

async function confirmDelay() {
	await vi.advanceTimersByTimeAsync(WORKSPACE_TRUST_CONFIRM_DELAY_MS + 1);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const entry of entries.splice(0)) {
		if (entry.active?.workspaceTrustConfirmTimer) clearTimeout(entry.active.workspaceTrustConfirmTimer);
		entry.terminalStateMirror?.dispose();
	}
	vi.useRealTimers();
});

describe("modern Codex trust output and input fencing", () => {
	it("confirms a complete ANSI viewport split across chunks without authoring work or state", async () => {
		const test = fixture();
		const split = MODERN_CODEX_TRUST_RENDER_ANSI.indexOf("Your trust");
		output(test, MODERN_CODEX_TRUST_RENDER_ANSI.slice(0, split));
		await flushMirror(test);
		await confirmDelay();
		expect(test.write).not.toHaveBeenCalled();
		output(test, MODERN_CODEX_TRUST_RENDER_ANSI.slice(split));
		await flushMirror(test);
		expect(test.write).not.toHaveBeenCalled();
		await confirmDelay();
		expect(test.write.mock.calls).toEqual([["\r"]]);
		expect(test.active.nativeWorkConfirmed).toBe(false);
		expect(test.summary.state).toBe("awaiting_review");
		expect(test.deps.updateStore).not.toHaveBeenCalled();
		expect(test.deps.applyTransitionEvent).not.toHaveBeenCalled();
	});

	it.each(["cancel", "cleared"] as const)(
		"cancels pending Enter before a %s redraw enters the delayed mirror queue",
		async (redraw) => {
			const test = fixture();
			output(test);
			await flushMirror(test);
			expect(test.active.workspaceTrustConfirmTimer).not.toBeNull();
			const mirror = test.entry.terminalStateMirror;
			if (!mirror) throw new Error("Missing test mirror");
			mirror.setBatching(true);
			const applied = vi.spyOn(mirror, "applyOutput");
			output(test, redraw === "cancel" ? renderModernCodexTrustANSI({ selection: "cancel" }) : CLEAR);
			expect(applied).toHaveBeenCalledOnce();
			expect(test.active.workspaceTrustConfirmTimer).toBeNull();
			await confirmDelay();
			expect(test.write).not.toHaveBeenCalled();
			mirror.setBatching(false);
			await flushMirror(test);
			await confirmDelay();
			expect(test.write).not.toHaveBeenCalled();
		},
	);

	it("ignores stale applied mirror callbacks when a newer decline frame is already queued", async () => {
		const test = fixture();
		output(test);
		output(test, renderModernCodexTrustANSI({ selection: "cancel" }));
		await flushMirror(test);
		await confirmDelay();
		expect(test.active.codexWorkspaceTrust?.outputRevision).toBe(2);
		expect(test.write).not.toHaveBeenCalled();
	});

	it("schedules only the latest complete frame when several selected redraws are queued", async () => {
		const test = fixture();
		output(test);
		output(test);
		output(test);
		await flushMirror(test);
		await confirmDelay();
		expect(test.active.codexWorkspaceTrust?.outputRevision).toBe(3);
		expect(test.write.mock.calls).toEqual([["\r"]]);
	});

	it("latches one Enter through selected and incomplete redraws until the dialog disappears", async () => {
		const test = fixture();
		output(test);
		await flushMirror(test);
		await confirmDelay();
		output(test);
		await flushMirror(test);
		await confirmDelay();
		output(test, "\u001b[2J\u001b[HFolder access\r\nTrust this folder?");
		await flushMirror(test);
		output(test);
		await flushMirror(test);
		await confirmDelay();
		expect(test.write.mock.calls).toEqual([["\r"]]);
		output(test, CLEAR);
		await flushMirror(test);
		output(test);
		await flushMirror(test);
		await confirmDelay();
		expect(test.write.mock.calls).toEqual([["\r"], ["\r"]]);
	});

	it.each(["before-apply", "pending"] as const)("direct user input takes over at the %s boundary", async (when) => {
		const test = fixture();
		output(test);
		if (when === "pending") await flushMirror(test);
		const down = Buffer.from("\u001b[B");
		processSessionInput(test.entry, test.entry.taskId, down, {
			getSummary: test.deps.getSummary,
			getEntry: () => test.entry,
			applyTransitionEvent: test.deps.applyTransitionEvent,
		});
		await flushMirror(test);
		await confirmDelay();
		// Even a stale selected redraw cannot override the user's selection.
		output(test);
		await flushMirror(test);
		await confirmDelay();
		expect(test.write.mock.calls).toEqual([[down]]);
		output(test, CLEAR);
		await flushMirror(test);
		output(test);
		await flushMirror(test);
		await confirmDelay();
		expect(test.write.mock.calls).toEqual([[down], ["\r"]]);
	});

	it("terminal protocol replies do not cancel pending startup confirmation", async () => {
		const test = fixture();
		output(test);
		await flushMirror(test);
		const response = Buffer.from("\u001b[1;1R");
		processSessionInput(test.entry, test.entry.taskId, response, {
			getSummary: test.deps.getSummary,
			getEntry: () => test.entry,
			applyTransitionEvent: test.deps.applyTransitionEvent,
		});
		await confirmDelay();
		expect(test.write.mock.calls).toEqual([[response], ["\r"]]);
	});

	it.each(["before-output", "pending"] as const)("native work at %s prevents startup confirmation", async (when) => {
		const test = fixture();
		if (when === "before-output") test.active.nativeWorkConfirmed = true;
		output(test);
		await flushMirror(test);
		test.active.nativeWorkConfirmed = true;
		await confirmDelay();
		expect(test.write).not.toHaveBeenCalled();
		expect(test.active.codexWorkspaceTrust).toBeNull();
		const mirror = test.entry.terminalStateMirror;
		if (!mirror) throw new Error("Missing test mirror");
		const apply = vi.spyOn(mirror, "applyOutput");
		output(test, "steady-state output");
		expect(apply.mock.calls[0][1]).toBeUndefined();
	});

	it.each(["exited", "replaced"] as const)("never writes Enter after the active launch is %s", async (kind) => {
		const test = fixture();
		output(test);
		await flushMirror(test);
		const replacement = fixture();
		test.entry.active = kind === "exited" ? null : replacement.active;
		await confirmDelay();
		expect(test.write).not.toHaveBeenCalled();
		expect(replacement.write).not.toHaveBeenCalled();
	});

	it("never schedules from an old launch's callback after replacement", async () => {
		const test = fixture();
		output(test);
		const replacement = fixture();
		test.entry.active = replacement.active;
		await flushMirror(test);
		await confirmDelay();
		expect(test.write).not.toHaveBeenCalled();
		expect(replacement.write).not.toHaveBeenCalled();
	});

	it.each(["claude", "pi", null] as const)("does not drive modern trust for %s sessions", async (agent) => {
		const test = fixture(agent);
		output(test);
		await flushMirror(test);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(test.write).not.toHaveBeenCalled();
	});

	it("preserves disabled trust policy and shell-session separation", async () => {
		const disabled = fixture("codex", false);
		output(disabled);
		await flushMirror(disabled);
		const shell = fixture();
		processShellSessionOutput(shell.entry, shell.entry.taskId, Buffer.from(MODERN_CODEX_TRUST_RENDER_ANSI));
		await flushMirror(shell);
		await confirmDelay();
		expect(disabled.write).not.toHaveBeenCalled();
		expect(shell.write).not.toHaveBeenCalled();
	});

	it("does not confirm tool approval containing a quoted full trust dialog", async () => {
		const test = fixture();
		output(
			test,
			`\u001b[2J\u001b[HWould you like to run this command?\r\nFolder access\r\n/synthetic/fixture\r\n${MODERN_CODEX_TRUST_DISCLOSURE}\r\n› 1. Trust and continue\r\n  2. Quit\r\nenter continue · esc quit\r\n› 1. Yes, proceed\r\nEsc to cancel`,
		);
		await flushMirror(test);
		await confirmDelay();
		expect(test.write).not.toHaveBeenCalled();
	});
});

describe("legacy Codex timer launch identity", () => {
	it("preserves the shared five-confirmation cap when modern trust follows four legacy prompts", async () => {
		const test = fixture();
		const legacy = "Do you trust the contents of this directory?";
		for (let count = 0; count < 4; count += 1) {
			output(test, legacy);
			await flushMirror(test);
			await confirmDelay();
		}
		expect(test.active.workspaceTrustConfirmCount).toBe(4);
		output(test);
		await flushMirror(test);
		await confirmDelay();
		expect(test.active.workspaceTrustConfirmCount).toBe(5);
		output(test, CLEAR);
		await flushMirror(test);
		output(test, legacy);
		await flushMirror(test);
		await confirmDelay();
		expect(test.write.mock.calls).toEqual(Array.from({ length: 5 }, () => ["\r"]));
		expect(test.active.workspaceTrustConfirmCount).toBe(5);
		expect(test.active.workspaceTrustConfirmTimer).toBeNull();
	});

	it("does not write to a replacement even if its own legacy auto-confirm flag is set", async () => {
		const test = fixture();
		processWorkspaceTrustOutput(test.active, test.entry.taskId, "Do you trust the contents of this directory?", {
			getActive: () => test.entry.active,
			updateStore: test.deps.updateStore,
		});
		const replacement = fixture();
		replacement.active.autoConfirmedWorkspaceTrust = true;
		test.entry.active = replacement.active;
		await confirmDelay();
		expect(test.write).not.toHaveBeenCalled();
		expect(replacement.write).not.toHaveBeenCalled();
	});
});
