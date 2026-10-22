import { describe, expect, it } from "vitest";

import {
	CLAUDE_RENDERED_INTERRUPTION_ESCAPE_WINDOW_MS,
	createClaudeTurnInterruptionDetector,
	isClaudeTurnInterruptedScreen,
} from "../../../src/terminal/claude-turn-interruption";
import type { TerminalScreenSnapshot } from "../../../src/terminal/terminal-state-mirror";
import {
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

function screen(lines: string[], cols = 80): TerminalScreenSnapshot {
	return { lines, cursorRow: Math.max(0, lines.length - 1), cols, rows: lines.length };
}

const RULE = "─".repeat(80);
const INTERRUPTION = "  ⎿  Interrupted · What should Claude do instead?";
const RULE_COMPOSER = [RULE, "❯ ", RULE, "  ⏵⏵ accept edits on (shift+tab to cycle)"];
const BOX_COMPOSER = [`╭${"─".repeat(78)}╮`, `│ > ${" ".repeat(75)}│`, `╰${"─".repeat(78)}╯`, "  ? for shortcuts"];
const TRANSCRIPT = ["> Fix the failing test", "", "⏺ Bash(npm test)"];

const interruptedScreen = screen([...TRANSCRIPT, INTERRUPTION, "", "", "", ...RULE_COMPOSER]);

describe("Claude rendered turn interruption", () => {
	it.each([
		["rule composer", interruptedScreen],
		["box composer", screen([...TRANSCRIPT, INTERRUPTION, "", ...BOX_COMPOSER])],
		["ASCII prompt glyph", screen([...TRANSCRIPT, INTERRUPTION, "", RULE, "> ", RULE])],
		["composer with typed text", screen([...TRANSCRIPT, INTERRUPTION, "", RULE, "❯ try a smaller fix", RULE])],
		[
			"multi-line composer and status line",
			screen([
				...TRANSCRIPT,
				INTERRUPTION,
				"",
				RULE,
				"❯ first line",
				"  second line",
				RULE,
				"  Opus · main · ctx 12%",
				"  ⏵⏵ accept edits on (shift+tab to cycle)",
			]),
		],
		[
			"interrupted text reply",
			screen(["> Explain the module", "", "⏺ The module", INTERRUPTION, "", ...RULE_COMPOSER]),
		],
		[
			"narrow terminal wrap",
			screen(
				[
					"> Fix the failing test",
					"",
					"  ⎿  Interrupted · What should Claude",
					"     do instead?",
					"",
					"─".repeat(40),
					"❯ ",
					"─".repeat(40),
				],
				40,
			),
		],
	])("recognizes the result directly above the newest composer: %s", (_name, snapshot) => {
		expect(isClaudeTurnInterruptedScreen(snapshot)).toBe(true);
	});

	it.each([
		["working spinner", ["✻ Working… (esc to interrupt)"]],
		["newer assistant reply", ["⏺ A newer response."]],
		["newer prompt", ["> Continue with the next step"]],
		["tip chrome", ["  ⎿  Tip: Use /memory to edit project memory"]],
	])("keeps a historical result inert beneath a %s", (_name, interveningRows) => {
		expect(
			isClaudeTurnInterruptedScreen(
				screen([...TRANSCRIPT, INTERRUPTION, "", ...interveningRows, "", ...RULE_COMPOSER]),
			),
		).toBe(false);
	});

	it.each([
		["quoted transcript text", ['  const message = "⎿  Interrupted · What should Claude do instead?";']],
		["partial result", ["  ⎿  Interrupted"]],
		["result with trailing text", ["  ⎿  Interrupted · What should Claude do instead? Extra output."]],
		["result without the result glyph", ["  Interrupted · What should Claude do instead?"]],
		["different result", ["  ⎿  Interrupted by user"]],
	])("rejects %s", (_name, rows) => {
		expect(isClaudeTurnInterruptedScreen(screen([...TRANSCRIPT, ...rows, "", ...RULE_COMPOSER]))).toBe(false);
	});

	it("requires the composer frame, not a transcript prompt row", () => {
		expect(isClaudeTurnInterruptedScreen(screen([...TRANSCRIPT, INTERRUPTION, "", "> Next prompt"]))).toBe(false);
		expect(isClaudeTurnInterruptedScreen(screen([...TRANSCRIPT, INTERRUPTION, "", RULE, "Plain text", RULE]))).toBe(
			false,
		);
		expect(isClaudeTurnInterruptedScreen(screen([...TRANSCRIPT, INTERRUPTION]))).toBe(false);
	});

	it("rejects a result rendered below the composer", () => {
		expect(isClaudeTurnInterruptedScreen(screen([...RULE_COMPOSER, INTERRUPTION]))).toBe(false);
	});

	it("anchors to the newest composer when an older frame remains in the viewport", () => {
		expect(
			isClaudeTurnInterruptedScreen(
				screen([...TRANSCRIPT, INTERRUPTION, "", RULE, "❯ ", RULE, "", "⏺ Later output", "", ...RULE_COMPOSER]),
			),
		).toBe(false);
	});

	it("rejects excessively wrapped result text", () => {
		expect(
			isClaudeTurnInterruptedScreen(
				screen(["  ⎿  Interrupted ·", "     What should", "     Claude do", "     instead?", "", ...RULE_COMPOSER]),
			),
		).toBe(false);
	});
});

describe("Claude rendered turn interruption detector", () => {
	const launch = "launch-1";
	const running = createTestTaskSessionSummary({ state: "running", agentId: "claude", sessionInstanceId: launch });

	it("stays inert without a preceding bare Escape", () => {
		const detector = createClaudeTurnInterruptionDetector(launch);
		expect(detector.shouldInspect(running)).toBe(false);
		expect(detector.detect(interruptedScreen, running)).toBeNull();
	});

	it("emits one conservative transition after Escape while Running", () => {
		let now = 1_000;
		const detector = createClaudeTurnInterruptionDetector(launch, () => now);
		detector.observeBareEscape(running, now);
		expect(detector.shouldInspect(running)).toBe(true);
		now += 10;
		expect(detector.detect(screen(["✻ Working… (esc to interrupt)", ...RULE_COMPOSER]), running)).toBeNull();
		expect(detector.detect(interruptedScreen, running)).toEqual({
			type: "agent.rendered-turn-interrupted",
			provider: "claude",
		});
		expect(detector.shouldInspect(running)).toBe(false);
		expect(detector.detect(interruptedScreen, running)).toBeNull();
	});

	it.each(["waiting", "response_submitted"] as const)(
		"arms for the current foreground Claude permission in %s",
		(status) => {
			const detector = createClaudeTurnInterruptionDetector(launch);
			const waiting = createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				agentId: "claude",
				sessionInstanceId: launch,
				outstandingInteraction: createTestTaskOutstandingInteraction({
					kind: "permission",
					status,
					toolName: "Bash",
				}),
			});
			detector.observeBareEscape(waiting, Date.now());
			expect(detector.detect(interruptedScreen, waiting)).toEqual({
				type: "agent.rendered-turn-interrupted",
				provider: "claude",
			});
		},
	);

	it.each([
		[
			"ordinary Review",
			createTestTaskSessionSummary({ state: "awaiting_review", reviewReason: "hook", agentId: "claude" }),
		],
		[
			"a question wait",
			createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				agentId: "claude",
				outstandingInteraction: createTestTaskOutstandingInteraction(),
			}),
		],
		[
			"a subagent permission",
			createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				agentId: "claude",
				outstandingInteraction: createTestTaskOutstandingInteraction({
					kind: "permission",
					providerAgentId: "agent-1",
				}),
			}),
		],
		["another provider", createTestTaskSessionSummary({ state: "running", agentId: "codex" })],
		[
			"a replacement launch",
			createTestTaskSessionSummary({ state: "running", agentId: "claude", sessionInstanceId: "launch-2" }),
		],
	])("does not arm or apply for %s", (_name, summary) => {
		const detector = createClaudeTurnInterruptionDetector(launch);
		detector.observeBareEscape(summary, Date.now());
		expect(detector.shouldInspect(summary)).toBe(false);
		expect(detector.detect(interruptedScreen, summary)).toBeNull();
		// An Escape armed for Running cannot apply after the task left Running.
		detector.observeBareEscape(running, Date.now());
		expect(detector.detect(interruptedScreen, summary)).toBeNull();
	});

	it("disarms when the Escape window expires", () => {
		let now = 1_000;
		const detector = createClaudeTurnInterruptionDetector(launch, () => now);
		detector.observeBareEscape(running, now);
		now += CLAUDE_RENDERED_INTERRUPTION_ESCAPE_WINDOW_MS + 1;
		expect(detector.shouldInspect(running)).toBe(false);
		expect(detector.detect(interruptedScreen, running)).toBeNull();
	});

	it("disarms when provider evidence establishes Running", () => {
		const detector = createClaudeTurnInterruptionDetector(launch);
		detector.observeBareEscape(running, Date.now());
		detector.reset();
		expect(detector.shouldInspect(running)).toBe(false);
		expect(detector.detect(interruptedScreen, running)).toBeNull();
	});
});
