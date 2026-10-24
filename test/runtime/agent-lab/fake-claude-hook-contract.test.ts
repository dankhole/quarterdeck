import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildClaudeHooksSettings } from "../../../src/claude-hooks";
import { useProcessTestBudget } from "../../utilities/process-test-budget";

useProcessTestBudget();
const execFileAsync = promisify(execFile);

it("accepts production Claude settings and delivers SubagentStop reliably", async () => {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-fake-claude-hooks-"));
	try {
		const home = join(root, "home");
		const stateHome = join(root, "state");
		await Promise.all([mkdir(home), mkdir(stateHome)]);
		const settingsPath = join(root, "settings.json");
		const capturePath = join(root, "hooks.jsonl");
		const hookEntryPath = join(root, "capture-hook.mjs");
		await writeFile(settingsPath, JSON.stringify(buildClaudeHooksSettings()));
		await writeFile(
			hookEntryPath,
			`import { appendFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
await appendFile(process.env.SYNTHETIC_HOOK_CAPTURE, JSON.stringify({ args: process.argv.slice(2), payload: JSON.parse(input) }) + "\\n");
`,
		);
		const execution = execFileAsync(
			process.execPath,
			[
				"--import",
				"tsx",
				resolve("scripts/agent-lab/fake-codex.ts"),
				"--settings",
				settingsPath,
				"--",
				"[agent-lab:idle] synthetic hook contract",
			],
			{
				env: {
					PATH: process.env.PATH,
					HOME: home,
					USERPROFILE: home,
					QUARTERDECK_STATE_HOME: stateHome,
					QUARTERDECK_AGENT_LAB: "1",
					QUARTERDECK_AGENT_LAB_PROVIDER: "claude",
					QUARTERDECK_AGENT_LAB_TSX_CLI: resolve("node_modules/tsx/dist/cli.mjs"),
					QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT: hookEntryPath,
					QUARTERDECK_HOOK_TASK_ID: "synthetic-task",
					QUARTERDECK_HOOK_PROJECT_ID: "synthetic-project",
					QUARTERDECK_HOOK_SESSION_INSTANCE_ID: "synthetic-launch",
					SYNTHETIC_HOOK_CAPTURE: capturePath,
				},
				timeout: 20_000,
				maxBuffer: 1024 * 1024,
			},
		);
		// Keep stdin open until the queued /exit command runs; EOF exits the fake immediately.
		execution.child.stdin?.write("/background-stop synthetic completion\n/exit 0\n");
		const result = await execution;
		expect(result.stdout).toContain("AGENT LAB READY");
		expect(result.stderr).toBe("");
		const captures: Array<{ args: string[]; payload: { hook_event_name: string } }> = (
			await readFile(capturePath, "utf8")
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const stop = captures.find((capture) => capture.payload.hook_event_name === "SubagentStop");
		expect(stop?.args).toEqual(["hooks", "ingest", "--event", "activity", "--source", "claude"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
