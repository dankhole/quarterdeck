import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { appendFakePiMessage, initializeFakePiHistory } from "../../../scripts/agent-lab/fake-pi-history";
import { useProcessTestBudget } from "../../utilities/process-test-budget";

useProcessTestBudget();

async function withFixture(operation: (root: string, environment: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-fake-pi-history-"));
	const stateHome = join(root, "state");
	try {
		await mkdir(stateHome);
		await operation(root, {
			PATH: process.env.PATH,
			TMPDIR: root,
			TEMP: root,
			HOME: root,
			USERPROFILE: root,
			QUARTERDECK_AGENT_LAB: "1",
			QUARTERDECK_STATE_HOME: stateHome,
			QUARTERDECK_AGENT_LAB_PROVIDER: "pi",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function options(environment: NodeJS.ProcessEnv, cwd: string) {
	return { environment, sessionId: "agent-lab-task-one", cwd, prompt: "Synthetic initial fallback" };
}

describe("fake Pi progress history", () => {
	it("writes native session/message records and continues the persisted parent chain on resume", async () => {
		await withFixture(async (root, environment) => {
			const input = options(environment, root);
			const history = await initializeFakePiHistory(input);
			await appendFakePiMessage(history, "assistant", "Synthetic live assistant");
			const resumed = await initializeFakePiHistory(input);
			expect(resumed.parentId).toBe(history.parentId);
			await appendFakePiMessage(resumed, "assistant", "Synthetic final response");
			const records = (await readFile(history.path, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(records[0]).toMatchObject({ type: "session", version: 3, id: input.sessionId, cwd: root });
			expect(records.slice(1).map((record) => record.message.content[0].text)).toEqual([
				input.prompt,
				"Synthetic live assistant",
				"Synthetic final response",
			]);
			expect(records[1].parentId).toBeNull();
			for (let i = 2; i < records.length; i++) expect(records[i].parentId).toBe(records[i - 1].id);
			for (const record of records) expect(Number.isFinite(Date.parse(record.timestamp))).toBe(true);
		});
	});

	it("requires isolated state and rejects identity escapes and symlinked history", async () => {
		await withFixture(async (root, environment) => {
			await expect(
				initializeFakePiHistory(options({ ...environment, QUARTERDECK_AGENT_LAB: undefined }, root)),
			).rejects.toThrow("explicit isolated");
			await expect(
				initializeFakePiHistory({ ...options(environment, root), sessionId: "../escape" }),
			).rejects.toThrow("identity");
			await expect(
				initializeFakePiHistory(options({ ...environment, QUARTERDECK_STATE_HOME: root }, root)),
			).rejects.toThrow("isolated fixture");
			const outside = join(root, "outside");
			await mkdir(outside);
			await mkdir(join(environment.QUARTERDECK_STATE_HOME as string, "agent-lab"));
			await symlink(
				outside,
				join(environment.QUARTERDECK_STATE_HOME as string, "agent-lab", "pi-history"),
				process.platform === "win32" ? "junction" : "dir",
			);
			await expect(initializeFakePiHistory(options(environment, root))).rejects.toThrow("symlinks");
		});
	});

	it("passes the exact Pi source hint through existing hooks while progress/final messages enter history", async () => {
		await withFixture(async (root, environment) => {
			const recorder = join(root, "record-hooks.mjs");
			const hookLog = join(root, "hooks.jsonl");
			await writeFile(
				recorder,
				'import { appendFileSync } from "node:fs"; appendFileSync(process.env.HOOK_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
			);
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					resolve("scripts/agent-lab/fake-codex.ts"),
					"[agent-lab:idle] Synthetic initial fallback",
				],
				{
					env: {
						...environment,
						QUARTERDECK_HOOK_TASK_ID: "task-one",
						QUARTERDECK_AGENT_LAB_TSX_CLI: recorder,
						QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT: "synthetic-cli",
						HOOK_LOG: hookLog,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let output = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				output += chunk;
			});
			try {
				await new Promise<void>((resolveRun, reject) => {
					const timeout = setTimeout(() => {
						reject(new Error(`Synthetic Pi timeout: ${output}`));
					}, 15_000);
					child.once("error", (error) => {
						clearTimeout(timeout);
						reject(error);
					});
					child.once("exit", (code) => {
						clearTimeout(timeout);
						code === 0 ? resolveRun() : reject(new Error(output));
					});
					child.stdin.write(
						"/working\n/progress Synthetic live assistant\n/review Synthetic final response\n/exit 0\n",
					);
				});
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill();
			}
			expect(output).toContain("AGENT LAB PROGRESS: Synthetic live assistant");
			const hooks: string[][] = (await readFile(hookLog, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const sourcePaths = hooks.map((args) => args[args.indexOf("--transcript-path") + 1]);
			expect(new Set(sourcePaths).size).toBe(1);
			expect(sourcePaths[0]).toContain("pi-history");
			expect(hooks.map((args) => args[args.indexOf("--hook-event-name") + 1])).toEqual(
				expect.arrayContaining(["session_meta", "AgentStart", "PostToolUse", "AgentEnd", "AgentSettled"]),
			);
			const records = (await readFile(sourcePaths[0], "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(records[0]).toMatchObject({ type: "session", id: "agent-lab-task-one" });
			expect(records.slice(1).map((record) => record.message.content[0].text)).toEqual([
				"[agent-lab:idle] Synthetic initial fallback",
				"Synthetic live assistant",
				"Synthetic final response",
			]);
		});
	});
});
