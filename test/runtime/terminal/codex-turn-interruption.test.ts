import { describe, expect, it } from "vitest";

import {
	createCodexTurnInterruptionDetector,
	isCodexTurnInterruptedScreen,
} from "../../../src/terminal/codex-turn-interruption";
import type { TerminalScreenSnapshot } from "../../../src/terminal/terminal-state-mirror";
import {
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

function screen(lines: string[]): TerminalScreenSnapshot {
	return {
		lines,
		cursorRow: Math.max(0, lines.length - 1),
		cols: 120,
		rows: lines.length,
	};
}

const interruptionScreen = screen([
	"",
	"■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to",
	"  report the issue.",
	"",
	"› Ask Codex to do anything",
	"gpt-5.6-sol xhigh",
]);

describe("Codex rendered turn interruption", () => {
	it("recognizes the complete interruption result followed by the Codex input prompt", () => {
		expect(isCodexTurnInterruptedScreen(interruptionScreen)).toBe(true);
	});

	it("does not treat quoted or partial transcript text as lifecycle evidence", () => {
		expect(
			isCodexTurnInterruptedScreen(
				screen([
					'const message = "■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the issue.";',
					"› Ask Codex to do anything",
				]),
			),
		).toBe(false);
		expect(
			isCodexTurnInterruptedScreen(
				screen([
					"› Ask Codex to do anything",
					"■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the issue.",
				]),
			),
		).toBe(false);
	});

	it("does not reinterpret a historical interruption above a newer turn as the current result", () => {
		expect(
			isCodexTurnInterruptedScreen(
				screen([
					"■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to",
					"  report the issue.",
					"",
					"› Ask Codex to do anything",
					"",
					"• Working on the follow-up",
					"  └ Read src/terminal/session-state-machine.ts",
					"",
					"› Ask Codex to do anything",
				]),
			),
		).toBe(false);
	});

	it("emits a conservative transition while the task claims Running", () => {
		const detector = createCodexTurnInterruptionDetector();
		expect(
			detector.detect(interruptionScreen, createTestTaskSessionSummary({ state: "running", agentId: "codex" })),
		).toEqual({ type: "agent.rendered-turn-interrupted" });
	});

	it.each(["waiting", "response_submitted"] as const)(
		"retires a current foreground Codex permission in %s",
		(status) => {
			const detector = createCodexTurnInterruptionDetector();
			expect(
				detector.detect(
					interruptionScreen,
					createTestTaskSessionSummary({
						state: "awaiting_review",
						agentId: "codex",
						outstandingInteraction: createTestTaskOutstandingInteraction({
							provider: "codex",
							kind: "permission",
							status,
							providerAgentId: null,
							responseSubmittedAt: status === "response_submitted" ? 2 : null,
							responseKind: status === "response_submitted" ? "cancel" : null,
						}),
					}),
				),
			).toEqual({ type: "agent.rendered-turn-interrupted" });
		},
	);

	it("does not retire ordinary Review or another provider's interaction", () => {
		const ordinaryReviewDetector = createCodexTurnInterruptionDetector();
		expect(
			ordinaryReviewDetector.detect(
				interruptionScreen,
				createTestTaskSessionSummary({ state: "awaiting_review", agentId: "codex" }),
			),
		).toBeNull();

		const claudeWaitDetector = createCodexTurnInterruptionDetector();
		expect(
			claudeWaitDetector.detect(
				interruptionScreen,
				createTestTaskSessionSummary({
					state: "awaiting_review",
					agentId: "claude",
					outstandingInteraction: createTestTaskOutstandingInteraction(),
				}),
			),
		).toBeNull();
	});

	it("does not replay the same rendered interruption after a provider hook until the screen clears", () => {
		const detector = createCodexTurnInterruptionDetector();
		const running = createTestTaskSessionSummary({ state: "running", agentId: "codex" });
		expect(detector.detect(interruptionScreen, running)).toEqual({ type: "agent.rendered-turn-interrupted" });
		expect(detector.detect(interruptionScreen, running)).toBeNull();
		expect(detector.detect(screen(["Working on the next turn"]), running)).toBeNull();
		expect(detector.detect(interruptionScreen, running)).toEqual({ type: "agent.rendered-turn-interrupted" });
	});

	it("latches an ineligible visible interruption so it cannot defeat a later working hook", () => {
		const detector = createCodexTurnInterruptionDetector();
		expect(
			detector.detect(
				interruptionScreen,
				createTestTaskSessionSummary({ state: "awaiting_review", agentId: "codex" }),
			),
		).toBeNull();
		expect(
			detector.detect(interruptionScreen, createTestTaskSessionSummary({ state: "running", agentId: "codex" })),
		).toBeNull();
	});
});
