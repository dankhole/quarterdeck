import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hasFakeClaudeHookCommand } from "../../../scripts/agent-lab/fake-agent-protocol";
import { buildClaudeHooksSettings } from "../../../src/claude-hooks";
import { buildQuarterdeckHookCommandLine } from "../../../src/core/quarterdeck-command";
import { useProcessTestBudget } from "../../utilities/process-test-budget";

useProcessTestBudget();
const execFileAsync = promisify(execFile);

describe.each(["linux", "win32"] as const)("fake Claude command validation on %s", (platform) => {
	const expected = ["hooks", "ingest", "--event", "activity", "--source", "claude"];
	const commandFor = (args: string[]) =>
		buildQuarterdeckHookCommandLine(
			args,
			{
				execPath:
					platform === "win32" ? "C:\\Program Files\\Quarterdeck's #1%\\node.exe" : "/opt/Quarterdeck's #1%/node",
				argv: ["node", "launch path #1%/cli.mjs"],
			},
			platform,
			{},
			"/synthetic/not-bundled.ts",
		);
	const groupsFor = (command: string) => [{ hooks: [{ type: "command", command }] }];

	it("accepts the production launcher with quoted paths", () => {
		expect(hasFakeClaudeHookCommand(groupsFor(commandFor(expected)), "ingest", "activity")).toBe(true);
		const notify = expected.map((arg) => (arg === "ingest" ? "notify" : arg));
		expect(hasFakeClaudeHookCommand(groupsFor(commandFor(notify)), "notify", "activity")).toBe(true);
	});

	it.each([
		["wrong delivery", ["hooks", "notify", "--event", "activity", "--source", "claude"]],
		["wrong event", ["hooks", "ingest", "--event", "to_review", "--source", "claude"]],
		["wrong source", ["hooks", "ingest", "--event", "activity", "--source", "codex"]],
		["extra arguments", [...expected, "--unexpected"]],
		["quoted POSIX decoy argument", [expected.map((arg) => `'${arg}'`).join(" ")]],
		["quoted Windows decoy argument", [expected.map((arg) => `"${arg}"`).join(" ")]],
	])("rejects %s", (_name, args) => {
		expect(hasFakeClaudeHookCommand(groupsFor(commandFor(args)), "ingest", "activity")).toBe(false);
	});

	it("does not mistake matcher text or non-command handlers for a command", () => {
		const command = commandFor(expected);
		for (const groups of [
			undefined,
			[{ matcher: command, hooks: [] }],
			[{ hooks: [{ type: "http", command }] }],
			[{ hooks: [{ type: "command", command: 1 }] }],
			groupsFor('""powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand YQ=="'),
		]) {
			expect(hasFakeClaudeHookCommand(groups, "ingest", "activity")).toBe(false);
		}
	});
});

it.each(["not-json", "null", '{"fileName":"node.exe","arguments":1}'])(
	"rejects malformed Windows launch records: %s",
	(launch) => {
		const encoded = Buffer.from(`$launch = ConvertFrom-Json -InputObject '${launch}'; `, "utf16le").toString(
			"base64",
		);
		const command = `""powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}"`;
		expect(hasFakeClaudeHookCommand([{ hooks: [{ type: "command", command }] }], "ingest", "activity")).toBe(false);
	},
);

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
