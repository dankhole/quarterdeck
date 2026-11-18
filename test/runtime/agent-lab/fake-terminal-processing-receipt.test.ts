import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { isCodexTurnInterruptedScreen } from "../../../src/terminal/codex-turn-interruption";
import { type TerminalScreenSnapshot, TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";
import { useProcessTestBudget } from "../../utilities/process-test-budget";

useProcessTestBudget();
const execFileAsync = promisify(execFile);

it("preserves historical redraw through the clipboard reply and still renders a subsequent current interruption", async () => {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-fake-rendered-receipt-"));
	try {
		const home = join(root, "home");
		const stateHome = join(root, "state");
		const hooksPath = join(root, "hooks.jsonl");
		const hookEntrypoint = join(root, "capture-hook.mjs");
		await Promise.all([mkdir(home), mkdir(stateHome)]);
		await writeFile(
			hookEntrypoint,
			'import { appendFile } from "node:fs/promises";\nawait appendFile(process.env.SYNTHETIC_HOOK_CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n");\n',
		);
		const execution = execFileAsync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				resolve("scripts/agent-lab/fake-codex.ts"),
				"-c",
				'hooks.Interrupt=[{ command = "synthetic hook contract" }]',
				"--",
				"[agent-lab:idle] synthetic historical redraw",
			],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					USERPROFILE: home,
					TMPDIR: root,
					TEMP: root,
					QUARTERDECK_STATE_HOME: stateHome,
					QUARTERDECK_AGENT_LAB: "1",
					QUARTERDECK_AGENT_LAB_PROVIDER: "codex",
					QUARTERDECK_AGENT_LAB_TSX_CLI: resolve("node_modules/tsx/dist/cli.mjs"),
					QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT: hookEntrypoint,
					QUARTERDECK_HOOK_TASK_ID: "synthetic-task",
					QUARTERDECK_HOOK_PROJECT_ID: "synthetic-project",
					QUARTERDECK_HOOK_SESSION_INSTANCE_ID: "synthetic-launch",
					SYNTHETIC_HOOK_CAPTURE: hooksPath,
				},
				timeout: 20_000,
				maxBuffer: 1024 * 1024,
			},
		);
		const completion = execution.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
		let output = "";
		let errors = "";
		execution.child.stdout?.on("data", (chunk: Buffer | string) => {
			output += String(chunk);
		});
		execution.child.stderr?.on("data", (chunk: Buffer | string) => {
			errors += String(chunk);
		});
		try {
			await expect.poll(() => `${errors}\n${output}`, { timeout: 10_000 }).toContain("AGENT LAB READY");
			await expect
				.poll(async () => readFile(hooksPath, "utf8").catch(() => ""), { timeout: 10_000 })
				.toContain("SessionStart");
			const beforeHooks = await readFile(hooksPath, "utf8");
			const encodedClipboard = Buffer.from("synthetic clipboard").toString("base64");
			const reply = `\u001b]52;c;${encodedClipboard}\u0007`;
			execution.child.stdin?.write("/clipboard-read\n");
			await expect.poll(() => output, { timeout: 10_000 }).toContain("AGENT LAB CLIPBOARD READ REQUESTED");
			// Exercise real query arming and fragmented reply handling before the
			// protocol-only receipt used to keep the historical screen untouched.
			execution.child.stdin?.write(reply.slice(0, 9));
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
			execution.child.stdin?.write(reply.slice(9));
			await expect
				.poll(() => output, { timeout: 10_000 })
				.toContain("AGENT LAB CLIPBOARD READ: synthetic clipboard");
			expect(output).not.toContain(encodedClipboard);
			const historicalFrame =
				"\u001b[2J\u001b[H\u001b[31m■ Conversation interrupted - tell the model what to do differently. " +
				"Something went wrong? Hit `/feedback` to report the issue.\u001b[0m\r\n\r\n" +
				"› Ask Codex to do anything\r\n\r\nAGENT LAB CURRENT TURN WORKING\r\n\r\n› Ask Codex to do anything";
			execution.child.stdin?.write("/redraw-interruption-history\n");
			await expect.poll(() => output, { timeout: 10_000 }).toContain(`${historicalFrame}\u001b]52;c;?\u0007`);
			const frameStart = output.indexOf(historicalFrame);
			const beforeReply = output.slice(frameStart);
			const snapshot = async (data: string): Promise<TerminalScreenSnapshot> => {
				const mirror = new TerminalStateMirror(140, 40);
				try {
					return await new Promise((resolveScreen) => mirror.applyOutput(Buffer.from(data), resolveScreen));
				} finally {
					mirror.dispose();
				}
			};
			expect(isCodexTurnInterruptedScreen(await snapshot(beforeReply))).toBe(false);
			execution.child.stdin?.write(reply);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			const afterReply = output.slice(frameStart);
			const afterScreen = await snapshot(afterReply);
			expect(isCodexTurnInterruptedScreen(afterScreen)).toBe(false);
			expect(afterScreen.lines.filter((line) => line.trim() === "› Ask Codex to do anything")).toHaveLength(2);
			expect(afterReply).toBe(beforeReply);
			// No Ctrl-U or work hook repairs the edit buffer after the protocol
			// reply: the next command must still reach Readline as written.
			const interruptionStart = output.length;
			execution.child.stdin?.write("/turn-interrupted\n");
			await expect
				.poll(() => output.slice(interruptionStart), { timeout: 10_000 })
				.toContain("\u001b[2J\u001b[H\u001b[31m■ Conversation interrupted");
			expect(isCodexTurnInterruptedScreen(await snapshot(output.slice(interruptionStart)))).toBe(true);
			execution.child.stdin?.write("/exit 0\n");
			const outcome = await completion;
			if ("error" in outcome) throw outcome.error;
			expect(outcome.result.stderr).toBe("");
			expect(await readFile(hooksPath, "utf8")).toBe(beforeHooks);
		} finally {
			if (execution.child.exitCode === null && execution.child.signalCode === null) execution.child.kill("SIGTERM");
			await completion;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
