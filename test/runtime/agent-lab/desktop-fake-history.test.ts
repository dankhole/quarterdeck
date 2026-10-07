import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDesktopFakeHistory } from "../../../scripts/agent-lab/desktop-fake-history";

describe("bounded synthetic desktop conversation history", () => {
	let root: string;
	let environment: NodeJS.ProcessEnv;
	let historyPath: string;
	const marker = "unique-synthetic-progress";
	function history(id = "agent-lab-task", text = marker): string {
		return `${JSON.stringify({ type: "session_meta", payload: { id } })}\n${JSON.stringify({ type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text }] } })}\n`;
	}
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "quarterdeck-fake-history-"));
		const home = join(root, "home");
		const state = join(root, "state");
		await Promise.all([mkdir(join(home, ".codex", "sessions"), { recursive: true }), mkdir(state)]);
		environment = { QUARTERDECK_AGENT_LAB: "1", TMPDIR: root, HOME: home, QUARTERDECK_STATE_HOME: state };
		historyPath = join(home, ".codex", "sessions", "rollout-agent-lab-task.jsonl");
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});
	it("returns only bounded bytes and digest and detects content loss", async () => {
		await writeFile(historyPath, history());
		const before = await readDesktopFakeHistory({ environment, taskId: "task", marker });
		expect(before).toEqual({ bytes: Buffer.byteLength(history()), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(JSON.stringify(before)).not.toContain(marker);
		await writeFile(historyPath, `${history()}${JSON.stringify({ type: "unrelated_metadata" })}\n`);
		expect(await readDesktopFakeHistory({ environment, taskId: "task", marker })).not.toEqual(before);
	});
	it.each([
		["agent-lab-other", marker],
		["agent-lab-task", "lost-progress"],
	])("rejects lost exact conversation or progress %s", async (id, text) => {
		await writeFile(historyPath, history(id, text));
		await expect(readDesktopFakeHistory({ environment, taskId: "task", marker })).rejects.toThrow(
			"exact seeded conversation",
		);
	});
	it("rejects a header-only retained file", async () => {
		await writeFile(historyPath, `${JSON.stringify({ type: "session_meta", payload: { id: "agent-lab-task" } })}\n`);
		await expect(readDesktopFakeHistory({ environment, taskId: "task", marker })).rejects.toThrow(
			"exact seeded conversation",
		);
	});
	it("rejects an oversized file before reading its content", async () => {
		await writeFile(historyPath, Buffer.alloc(2 * 1024 * 1024 + 1));
		await expect(readDesktopFakeHistory({ environment, taskId: "task", marker })).rejects.toThrow("bound");
	});
});
