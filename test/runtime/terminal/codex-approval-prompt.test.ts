import { describe, expect, it } from "vitest";

import { createCodexApprovalPromptDetector, isCodexApprovalScreen } from "../../../src/terminal/codex-approval-prompt";
import type { TerminalScreenSnapshot } from "../../../src/terminal/terminal-state-mirror";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const runningCodexSummary = createTestTaskSessionSummary({
	state: "running",
	agentId: "codex",
	pid: 123,
});

function screen(lines: string[], options: { cols?: number; rows?: number } = {}): TerminalScreenSnapshot {
	const rows = options.rows ?? lines.length;
	return {
		lines: [...lines, ...Array.from({ length: Math.max(0, rows - lines.length) }, () => "")],
		cursorRow: Math.min(lines.length - 1, rows - 1),
		cols: options.cols ?? 80,
		rows,
	};
}

function approvalScreen(title: string, footer = "Press enter to confirm or esc to cancel"): TerminalScreenSnapshot {
	return screen([
		"",
		`  ${title}`,
		"",
		"  $ npm test",
		"",
		"› 1. Yes, proceed (y)",
		"  2. No, and tell Codex what to do differently (esc)",
		"",
		`  ${footer}`,
	]);
}

describe("createCodexApprovalPromptDetector", () => {
	it("detects a rendered canonical command approval bottom pane", () => {
		const detector = createCodexApprovalPromptDetector();

		expect(
			detector.detect(approvalScreen("Would you like to run the following command?"), runningCodexSummary),
		).toEqual({ type: "agent.permission-prompt" });
	});

	it.each([
		"Would you like to grant these permissions?",
		"Would you like to make the following edits?",
		'Do you want to approve network access to "api.github.com"?',
		"example-mcp needs your approval.",
	])("detects the Codex approval title %s", (title) => {
		expect(isCodexApprovalScreen(approvalScreen(title))).toBe(true);
	});

	it("accepts wrapped titles and a footer clipped at the supported 40-column width", () => {
		const narrow = screen(
			[
				"",
				"  Would you like to run the following",
				"  command?",
				"",
				"› 1. Yes, proceed (y)",
				"  2. No, and tell Codex what to do",
				"     differently (esc)",
				"",
				"  Press enter to confirm or esc to cance",
			],
			{ cols: 40 },
		);

		expect(isCodexApprovalScreen(narrow)).toBe(true);
	});

	it("does not treat source or transcript text as a rendered approval layout", () => {
		const sourceOutput = screen([
			'const title = "Would you like to run the following command?";',
			'const selected = "› 1. Yes, proceed";',
			'const footer = "Press enter to confirm or esc to cancel";',
		]);

		expect(isCodexApprovalScreen(sourceOutput)).toBe(false);
	});

	it("requires an anchored footer, selected choice, and canonical title", () => {
		const prompt = approvalScreen("Would you like to run the following command?");
		expect(isCodexApprovalScreen({ ...prompt, lines: prompt.lines.map((line) => line.replace("›", " ")) })).toBe(
			false,
		);
		expect(isCodexApprovalScreen(screen([...prompt.lines, "lab> "], { rows: prompt.rows + 1 }))).toBe(false);
		expect(isCodexApprovalScreen(approvalScreen("Choose a model"))).toBe(false);
	});

	it("latches across redraws and re-arms only after the overlay disappears", () => {
		const detector = createCodexApprovalPromptDetector();
		const prompt = approvalScreen("Would you like to run the following command?");

		expect(detector.detect(prompt, runningCodexSummary)).toEqual({ type: "agent.permission-prompt" });
		expect(detector.detect(prompt, runningCodexSummary)).toBeNull();
		expect(detector.detect(screen(["Working…"]), runningCodexSummary)).toBeNull();
		expect(detector.detect(prompt, runningCodexSummary)).toEqual({ type: "agent.permission-prompt" });
	});

	it("can still be explicitly reset after provider-confirmed work", () => {
		const detector = createCodexApprovalPromptDetector();
		const prompt = approvalScreen("Would you like to run the following command?");

		expect(detector.detect(prompt, runningCodexSummary)).toEqual({ type: "agent.permission-prompt" });
		detector.reset();
		expect(detector.detect(prompt, runningCodexSummary)).toEqual({ type: "agent.permission-prompt" });
	});
});
