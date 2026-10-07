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
const composerTip = "  Tip: Use /fast to enable our fastest inference with increased plan usage.";
const interruptionWithTipScreen = screen([
	...interruptionScreen.lines.slice(0, 4),
	composerTip,
	"",
	...interruptionScreen.lines.slice(4),
]);
const capacityMessage = "■ Selected model is at capacity. Please try a different model.";
const capacityScreen = screen([capacityMessage, "", "› Ask Codex to do anything", "gpt-6-astra high"]);
const capacityWithTipScreen = screen([capacityMessage, "", composerTip, "", "› Ask Codex to do anything"]);

describe("Codex rendered turn failure", () => {
	it("recognizes the complete interruption result followed by the Codex input prompt", () => {
		expect(isCodexTurnInterruptedScreen(interruptionScreen)).toBe(true);
	});

	it("recognizes the complete result across the adjacent Codex composer tip", () => {
		expect(isCodexTurnInterruptedScreen(interruptionWithTipScreen)).toBe(true);
	});

	it("preserves normalized composer matching on indented viewport rows", () => {
		expect(
			isCodexTurnInterruptedScreen(
				screen([...interruptionWithTipScreen.lines.slice(0, 6), "  ›   Ask  CODEX to do anything  "]),
			),
		).toBe(true);
	});

	it.each([
		["• Working on the follow-up", "", composerTip],
		["› Continue working", "", composerTip],
		[composerTip, "A newer assistant response."],
		[composerTip, "  A second row of transcript text."],
		[composerTip, "", composerTip],
		["Tip:"],
		["> Tip: Use /fast to enable our fastest inference with increased plan usage."],
	])("does not skip newer transcript or arbitrary chrome: %j", (...interveningRows) => {
		expect(
			isCodexTurnInterruptedScreen(
				screen([
					...interruptionScreen.lines.slice(0, 4),
					...interveningRows,
					"",
					...interruptionScreen.lines.slice(4),
				]),
			),
		).toBe(false);
	});

	it("still requires the complete interruption result when composer chrome is present", () => {
		expect(
			isCodexTurnInterruptedScreen(
				screen([
					"■ Conversation interrupted - tell the model what to do differently.",
					"",
					composerTip,
					"",
					"› Ask Codex to do anything",
				]),
			),
		).toBe(false);
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

	it.each([
		capacityScreen,
		capacityWithTipScreen,
		screen(["■ Selected model is at capacity.", "  Please try a different model.", "", "› Ask Codex to do anything"]),
	])("recognizes the complete model-capacity failure at the current composer: %j", (snapshot) => {
		expect(isCodexTurnInterruptedScreen(snapshot)).toBe(true);
	});

	it.each([
		["■ Selected model is at capacity.", "", composerTip, "", "› Ask Codex to do anything"],
		[
			'const message = "■ Selected model is at capacity. Please try a different model.";',
			"› Ask Codex to do anything",
		],
		[`> ${capacityMessage}`, "› Ask Codex to do anything"],
		[`${capacityMessage} More output.`, "› Ask Codex to do anything"],
		["Selected model is at capacity. Please try a different model.", "› Ask Codex to do anything"],
		[capacityMessage],
		["› Ask Codex to do anything", capacityMessage],
		["■ Selected", "model is", "at capacity.", "Please try", "a different", "model.", "› Ask Codex to do anything"],
	])("rejects incomplete, quoted, unanchored, or excessively wrapped capacity text: %j", (...lines) => {
		expect(isCodexTurnInterruptedScreen(screen(lines))).toBe(false);
	});

	it.each([
		["• Working on the follow-up", "", composerTip],
		["A newer assistant response."],
		[composerTip, "A newer assistant response."],
		[composerTip, "", composerTip],
		["Tip:"],
	])("keeps historical capacity text inert beneath newer result or chrome rows: %j", (...interveningRows) => {
		expect(
			isCodexTurnInterruptedScreen(
				screen([capacityMessage, "", ...interveningRows, "", "› Ask Codex to do anything"]),
			),
		).toBe(false);
	});

	it("anchors capacity failures to the newest composer", () => {
		expect(
			isCodexTurnInterruptedScreen(
				screen([
					...capacityScreen.lines.slice(0, 3),
					"",
					"• Working on the follow-up",
					"",
					composerTip,
					"",
					"› Ask Codex to do anything",
				]),
			),
		).toBe(false);
	});
});

describe.each([
	{ result: "interruption", snapshot: interruptionScreen, snapshotWithTip: interruptionWithTipScreen },
	{ result: "capacity failure", snapshot: capacityScreen, snapshotWithTip: capacityWithTipScreen },
])("Codex rendered $result transitions", ({ snapshot, snapshotWithTip }) => {
	it("emits a conservative transition while the task claims Running", () => {
		const detector = createCodexTurnInterruptionDetector();
		expect(detector.detect(snapshot, createTestTaskSessionSummary({ state: "running", agentId: "codex" }))).toEqual({
			type: "agent.rendered-turn-interrupted",
		});
	});

	it.each(["waiting", "response_submitted"] as const)(
		"retires a current foreground Codex permission in %s",
		(status) => {
			const detector = createCodexTurnInterruptionDetector();
			expect(
				detector.detect(
					snapshotWithTip,
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
				snapshot,
				createTestTaskSessionSummary({ state: "awaiting_review", agentId: "codex" }),
			),
		).toBeNull();

		const claudeWaitDetector = createCodexTurnInterruptionDetector();
		expect(
			claudeWaitDetector.detect(
				snapshot,
				createTestTaskSessionSummary({
					state: "awaiting_review",
					agentId: "claude",
					outstandingInteraction: createTestTaskOutstandingInteraction(),
				}),
			),
		).toBeNull();
	});

	it("does not replay the same rendered failure after a provider hook until the screen clears", () => {
		const detector = createCodexTurnInterruptionDetector();
		const running = createTestTaskSessionSummary({ state: "running", agentId: "codex" });
		expect(detector.detect(snapshot, running)).toEqual({ type: "agent.rendered-turn-interrupted" });
		expect(detector.detect(snapshotWithTip, running)).toBeNull();
		expect(detector.detect(snapshot, running)).toBeNull();
		expect(detector.detect(screen(["Working on the next turn"]), running)).toBeNull();
		expect(detector.detect(snapshot, running)).toEqual({ type: "agent.rendered-turn-interrupted" });
	});

	it("latches an ineligible visible failure so it cannot defeat a later working hook", () => {
		const detector = createCodexTurnInterruptionDetector();
		expect(
			detector.detect(snapshot, createTestTaskSessionSummary({ state: "awaiting_review", agentId: "codex" })),
		).toBeNull();
		expect(
			detector.detect(snapshot, createTestTaskSessionSummary({ state: "running", agentId: "codex" })),
		).toBeNull();
	});
});
