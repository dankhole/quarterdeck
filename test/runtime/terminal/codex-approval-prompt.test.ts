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
	it("recognizes the 0.157.0 fullscreen command approval below visible conversation history", () => {
		// Layout observed in the real-Codex Agent Lab, including its bottom-anchored footer.
		const lines = Array.from({ length: 50 }, () => "");
		lines[0] = "• ORBIT-157";
		lines.splice(
			36,
			14,
			"  Would you like to run the following command?",
			"",
			"  Environment: local",
			"",
			"  Reason: May I run the requested command with elevated permissions?",
			"",
			"  $ printf test > daemon-check.txt",
			"",
			"",
			"› 1. Yes, proceed (y)",
			"  2. Yes, and don't ask again for commands that start with `printf test > daemon-check.txt` (p)",
			"  3. No, and tell Codex what to do differently (esc)",
			"",
			"  Press enter to confirm or esc to cancel",
		);
		expect(isCodexApprovalScreen(screen(lines, { cols: 167, rows: 50 }))).toBe(true);
	});

	it("recognizes a subagent approval routed to the main TUI with its thread label", () => {
		// Codex 0.163.0 labels another thread's request with a `Thread:` header
		// and adds an open-thread hint to the footer.
		const lines = [
			"",
			"  Would you like to run the following command?",
			"",
			"  Thread: Robie [explorer]",
			"",
			"  Reason: Run the synthetic check outside the sandbox?",
			"",
			"  $ npm test",
			"",
			"› 1. Yes, proceed (y)",
			"  2. No, and tell Codex what to do differently (esc)",
			"",
			"  Press enter to confirm or esc to cancel or o to open thread",
		];
		expect(isCodexApprovalScreen(screen(lines))).toBe(true);
		// A narrow terminal clips the longer footer rather than wrapping it.
		expect(
			isCodexApprovalScreen(screen([...lines.slice(0, -1), "  Press enter to confirm or esc to cancel or o"])),
		).toBe(true);
	});

	it("detects a rendered canonical command approval bottom pane", () => {
		const detector = createCodexApprovalPromptDetector();

		expect(
			detector.detect(approvalScreen("Would you like to run the following command?"), runningCodexSummary),
		).toEqual({ type: "agent.permission-prompt", threadLabeled: false });
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

		expect(detector.detect(prompt, runningCodexSummary)).toEqual({
			type: "agent.permission-prompt",
			threadLabeled: false,
		});
		expect(detector.detect(prompt, runningCodexSummary)).toBeNull();
		expect(detector.detect(screen(["Working…"]), runningCodexSummary)).toBeNull();
		expect(detector.detect(prompt, runningCodexSummary)).toEqual({
			type: "agent.permission-prompt",
			threadLabeled: false,
		});
	});

	it("re-arms when a different queued approval replaces the overlay without an empty frame", () => {
		const detector = createCodexApprovalPromptDetector();
		const subagent = screen([
			"",
			"  Would you like to run the following command?",
			"",
			"  Thread: Robie [explorer]",
			"",
			"  $ npm test",
			"",
			"› 1. Yes, proceed (y)",
			"  2. No, and tell Codex what to do differently (esc)",
			"",
			"  Press enter to confirm or esc to cancel or o to open thread",
		]);
		const subagentSecondRow = screen(
			subagent.lines.map((line) =>
				line.startsWith("›")
					? line.replace("›", " ")
					: line.startsWith("  2.")
						? line.replace("  2.", "› 2.")
						: line,
			),
		);
		const foreground = approvalScreen("Would you like to make the following edits?");

		expect(detector.detect(subagent, runningCodexSummary)).toEqual({
			type: "agent.permission-prompt",
			threadLabeled: true,
		});
		// Moving the selection is the same request.
		expect(detector.detect(subagentSecondRow, runningCodexSummary)).toBeNull();
		expect(detector.detect(foreground, runningCodexSummary)).toEqual({
			type: "agent.permission-prompt",
			threadLabeled: false,
		});
		expect(detector.detect(foreground, runningCodexSummary)).toBeNull();
	});

	it("can still be explicitly reset after provider-confirmed work", () => {
		const detector = createCodexApprovalPromptDetector();
		const prompt = approvalScreen("Would you like to run the following command?");

		expect(detector.detect(prompt, runningCodexSummary)).toEqual({
			type: "agent.permission-prompt",
			threadLabeled: false,
		});
		detector.reset();
		expect(detector.detect(prompt, runningCodexSummary)).toEqual({
			type: "agent.permission-prompt",
			threadLabeled: false,
		});
	});
});
