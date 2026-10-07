import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectOwnedDesktopProcesses, listDesktopProcesses } from "../../../scripts/agent-lab/desktop-processes";
import {
	type FakeInvocationReceipt,
	FakeInvocationReceiptSchema,
	hasFakeCodexHistory,
	initializeFreshFakeCodexHistory,
	readFakeInvocationReceipt,
	resolveFakeCodexHistoryPath,
	resolveFakeInvocationReceiptPath,
	writeFakeInvocationReceipt,
} from "../../../scripts/agent-lab/fake-invocation-receipt";
import { writeAgentProviderLaunchers } from "../../../scripts/agent-lab/fixture";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";

const execFileAsync = promisify(execFile);
const receipt: FakeInvocationReceipt = {
	version: 1,
	provider: "codex",
	taskId: "abc12",
	sessionInstanceId: "launch-one",
	pid: 123,
	providerSessionId: "agent-lab-abc12",
	resumeKind: "targeted",
	requestedSessionId: "agent-lab-abc12",
	historyPresent: true,
};

async function withFixture(
	operation: (fixture: { root: string; stateHome: string; environment: NodeJS.ProcessEnv }) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-fake-invocation-"));
	const stateHome = join(root, "state");
	const home = join(root, "home");
	try {
		await Promise.all([mkdir(stateHome), mkdir(home)]);
		await operation({
			root,
			stateHome,
			environment: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: root,
				TEMP: root,
				QUARTERDECK_STATE_HOME: stateHome,
				QUARTERDECK_AGENT_LAB: "1",
				QUARTERDECK_AGENT_LAB_PROVIDER: "codex",
			},
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function launchFake(
	environment: NodeJS.ProcessEnv,
	options: { taskId: string; sessionInstanceId?: string; requestedSessionId?: string },
): Promise<{ pid: number; completion: Promise<unknown> }> {
	const launch = await prepareAgentLaunch({
		agentId: "codex",
		taskId: options.taskId,
		args: [],
		cwd: "/synthetic/project",
		projectPath: "/synthetic/project",
		projectId: "project-one",
		hookSessionInstanceId: options.sessionInstanceId,
		prompt: "synthetic-only prompt",
		resumeConversation: options.requestedSessionId !== undefined,
		resumeSessionId: options.requestedSessionId,
	});
	const execution = execFileAsync(
		process.execPath,
		["--import", "tsx", resolve("scripts/agent-lab/fake-codex.ts"), ...launch.args],
		{
			env: { ...environment, ...launch.env },
			timeout: 5_000,
			maxBuffer: 16_384,
		},
	);
	execution.child.stdin?.end("/exit 0\n");
	const pid = execution.child.pid;
	if (!pid) throw new Error("Synthetic provider did not start.");
	return { pid, completion: execution };
}

describe("fake invocation receipts", () => {
	it.skipIf(process.platform === "win32")(
		"captures the generated TSX launcher's worker within its exact process tree",
		async () => {
			await withFixture(async ({ root, environment, stateHome }) => {
				const binPath = join(root, "bin");
				await mkdir(binPath);
				await writeAgentProviderLaunchers(binPath, { mode: "fake" });
				const launch = await prepareAgentLaunch({
					agentId: "codex",
					taskId: "abc12",
					args: [],
					cwd: root,
					projectPath: root,
					projectId: "project-one",
					hookSessionInstanceId: "launch-one",
					prompt: "synthetic launcher contract",
				});
				const execution = execFileAsync(join(binPath, "codex"), launch.args, {
					env: {
						...environment,
						...launch.env,
						QUARTERDECK_AGENT_LAB_NODE: process.execPath,
						QUARTERDECK_AGENT_LAB_TSX_CLI: resolve("node_modules/tsx/dist/cli.mjs"),
						QUARTERDECK_AGENT_LAB_FAKE_AGENT: resolve("scripts/agent-lab/fake-codex.ts"),
					},
					timeout: 8_000,
					maxBuffer: 16_384,
				});
				// Keep an early child failure handled while polling its startup evidence.
				const completion = execution.then(
					(result) => ({ result }),
					(error: unknown) => ({ error }),
				);
				try {
					const rootPid = execution.child.pid;
					if (!rootPid) throw new Error("Generated synthetic launcher did not start.");
					await expect
						.poll(() => readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" }), {
							timeout: 5_000,
						})
						.not.toBeNull();
					const captured = await readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" });
					if (!captured) throw new Error("Generated synthetic launch has no receipt.");
					const processes = collectOwnedDesktopProcesses(await listDesktopProcesses(), [rootPid]);
					expect(captured.pid).not.toBe(rootPid);
					expect(processes.some((process) => process.pid === captured.pid)).toBe(true);
				} finally {
					execution.child.stdin?.end("/exit 0\n");
					await completion;
				}
				const outcome = await completion;
				if ("error" in outcome) throw outcome.error;
			});
		},
	);

	it("skips receipts without launch identity and keeps probe calls independent of fixture history", async () => {
		await withFixture(async ({ environment, stateHome }) => {
			const fresh = await launchFake(environment, { taskId: "abc12" });
			await fresh.completion;
			expect(await readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" })).toBeNull();
			const probe = await execFileAsync(
				process.execPath,
				["--import", "tsx", resolve("scripts/agent-lab/fake-codex.ts"), "--version"],
				{
					env: { PATH: process.env.PATH },
					timeout: 5_000,
				},
			);
			expect(probe.stdout.trim()).toBe("codex-cli 0.157.0");
		});
	});

	it("records actual fresh and targeted argv separately while preserving exact seeded history", async () => {
		await withFixture(async ({ environment, stateHome }) => {
			const fresh = await launchFake(environment, { taskId: "abc12", sessionInstanceId: "launch-one" });
			await fresh.completion;
			expect(await readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" })).toEqual({
				...receipt,
				pid: fresh.pid,
				resumeKind: "fresh",
				requestedSessionId: null,
			});
			const historyPath = await resolveFakeCodexHistoryPath(environment, "agent-lab-abc12");
			await appendFile(
				historyPath,
				`${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "unique synthetic recovery marker" }] } })}\n`,
			);
			const before = await readFile(historyPath);
			const resumed = await launchFake(environment, {
				taskId: "def34",
				sessionInstanceId: "launch-two",
				requestedSessionId: "agent-lab-abc12",
			});
			await resumed.completion;
			expect(await readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-two" })).toEqual({
				...receipt,
				taskId: "def34",
				sessionInstanceId: "launch-two",
				pid: resumed.pid,
			});
			expect(await readFile(historyPath)).toEqual(before);
			expect(
				await readFile(resolveFakeInvocationReceiptPath({ stateHome, sessionInstanceId: "launch-two" }), "utf8"),
			).not.toContain("synthetic-only prompt");
		});
	});

	it("records missing targeted history without creating it or reporting provider readiness", async () => {
		await withFixture(async ({ environment, stateHome }) => {
			const resumed = await launchFake(environment, {
				taskId: "abc12",
				sessionInstanceId: "launch-one",
				requestedSessionId: "agent-lab-abc12",
			});
			await expect(resumed.completion).rejects.toMatchObject({
				code: 1,
				stdout: expect.not.stringContaining("AGENT LAB READY"),
			});
			expect(await readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" })).toEqual({
				...receipt,
				pid: resumed.pid,
				historyPresent: false,
			});
			expect(
				await hasFakeCodexHistory(
					await resolveFakeCodexHistoryPath(environment, "agent-lab-abc12"),
					"agent-lab-abc12",
				),
			).toBe(false);
		});
	});

	it("requires explicit isolated history and rejects outside or symlinked profiles", async () => {
		await withFixture(async ({ root, environment }) => {
			expect(
				await resolveFakeCodexHistoryPath(
					{ ...environment, CODEX_HOME: join(environment.HOME as string, ".codex") },
					"agent-lab-abc12",
				),
			).toBe(await resolveFakeCodexHistoryPath(environment, "agent-lab-abc12"));
			await expect(
				resolveFakeCodexHistoryPath({ ...environment, QUARTERDECK_AGENT_LAB: undefined }, "agent-lab-abc12"),
			).rejects.toThrow("explicit isolated");
			const outside = join(root, "other-profile");
			await mkdir(outside);
			await expect(
				resolveFakeCodexHistoryPath({ ...environment, CODEX_HOME: outside }, "agent-lab-abc12"),
			).rejects.toThrow("isolated fixture");
			await symlink(
				outside,
				join(environment.HOME as string, ".codex"),
				process.platform === "win32" ? "junction" : "dir",
			);
			await expect(resolveFakeCodexHistoryPath(environment, "agent-lab-abc12")).rejects.toThrow("symlinks");
		});
	});

	it("does not overwrite history and rejects mismatched or malformed metadata", async () => {
		await withFixture(async ({ environment }) => {
			const path = await resolveFakeCodexHistoryPath(environment, "agent-lab-abc12");
			await initializeFreshFakeCodexHistory(path, "agent-lab-abc12", "0.157.0");
			const before = await readFile(path);
			await initializeFreshFakeCodexHistory(path, "other-session", "0.157.0");
			expect(await readFile(path)).toEqual(before);
			expect(await hasFakeCodexHistory(path, "other-session")).toBe(false);
			await writeFile(path, "not-json\n");
			expect(await hasFakeCodexHistory(path, "agent-lab-abc12")).toBe(false);
		});
	});

	it("bounds strict receipts and refuses another launch identity or symlink target", async () => {
		await withFixture(async ({ root, stateHome }) => {
			expect(await readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" })).toBeNull();
			await writeFakeInvocationReceipt({ stateHome, receipt });
			const path = resolveFakeInvocationReceiptPath({ stateHome, sessionInstanceId: "launch-one" });
			expect((await stat(path)).size).toBeLessThan(2_048);
			expect(FakeInvocationReceiptSchema.safeParse({ ...receipt, prompt: "forbidden" }).success).toBe(false);
			expect(FakeInvocationReceiptSchema.safeParse({ ...receipt, requestedSessionId: "other" }).success).toBe(false);
			expect(() => resolveFakeInvocationReceiptPath({ stateHome, sessionInstanceId: "../outside" })).toThrow();
			await writeFile(path, JSON.stringify({ ...receipt, sessionInstanceId: "launch-two" }));
			await expect(readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" })).rejects.toThrow(
				"another launch identity",
			);
			await writeFile(path, " ".repeat(2_049));
			await expect(readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" })).rejects.toThrow(
				"byte limit",
			);
			await rm(path);
			const outside = join(root, "outside-receipt");
			await writeFile(outside, "untouched");
			await symlink(outside, path);
			await expect(writeFakeInvocationReceipt({ stateHome, receipt })).rejects.toThrow("symlinks");
			await expect(readFakeInvocationReceipt({ stateHome, sessionInstanceId: "launch-one" })).rejects.toThrow(
				"symlinks",
			);
			expect(await readFile(outside, "utf8")).toBe("untouched");
		});
	});
});
