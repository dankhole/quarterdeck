import { describe, expect, it } from "vitest";
import { renderFakeCodexInterruption } from "../../../scripts/agent-lab/fake-codex-interruption";
import { createCodexTurnInterruptionDetector } from "../../../src/terminal/codex-turn-interruption";
import { type TerminalScreenSnapshot, TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function apply(mirror: TerminalStateMirror, frame: string): Promise<TerminalScreenSnapshot> {
	return new Promise((resolve) => mirror.applyOutput(Buffer.from(frame), resolve));
}

const runningCodex = createTestTaskSessionSummary({ agentId: "codex", state: "running" });
const interruption = { type: "agent.rendered-turn-interrupted", provider: "codex" };

describe("packaged lab Codex interruption frames", () => {
	it.each([114, 80, 38])("distinguishes current and historical interruptions at %i columns", async (cols) => {
		// The packaged Windows screenshot was 114 columns: printing a single
		// unwrapped result divided `report` into `repor` and `t the issue.`.
		const mirror = new TerminalStateMirror(cols, 40);
		const detector = createCodexTurnInterruptionDetector();
		try {
			const current = renderFakeCodexInterruption(cols, "current");
			const historical = renderFakeCodexInterruption(cols, "historical");
			expect(detector.detect(await apply(mirror, current), runningCodex)).toEqual(interruption);
			const redrawn = await apply(mirror, historical);
			expect(redrawn.lines).toContain("AGENT LAB CURRENT TURN WORKING");
			expect(detector.detect(redrawn, runningCodex)).toBeNull();
			expect(detector.detect(await apply(mirror, current), runningCodex)).toEqual(interruption);
		} finally {
			mirror.dispose();
		}
	});
});
