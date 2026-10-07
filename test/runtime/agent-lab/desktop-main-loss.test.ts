import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopLabFixture } from "../../../scripts/agent-lab/desktop-fixture";
import {
	assertDesktopMainLossRecovery,
	DesktopMainLossError,
	type DesktopMainLossOwner,
	type DesktopMainLossProof,
	type DesktopMainLossRecovery,
	desktopMainLossHistoryMarker,
	proveDesktopMainProcessLoss,
	readDesktopMainLossHistory,
	readDesktopMainLossOwner,
} from "../../../scripts/agent-lab/desktop-main-loss";
import type { DesktopLabProcess, DesktopProcessEvidence } from "../../../scripts/agent-lab/desktop-types";
import type { FakeInvocationReceipt } from "../../../scripts/agent-lab/fake-invocation-receipt";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api/task-session";
import { discoverRuntimeOwner } from "../../../src/server/runtime-ownership";

vi.mock("../../../src/server/runtime-ownership", () => ({ discoverRuntimeOwner: vi.fn() }));

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<DesktopLabFixture> {
	const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "quarterdeck-main-loss-test-")));
	roots.push(tempRoot);
	const config = {
		version: 1 as const,
		tempRoot,
		stateHome: join(tempRoot, "state"),
		userDataPath: join(tempRoot, "user data"),
		projectPath: join(tempRoot, "project"),
		hostSimulationConfigPath: join(tempRoot, "host.json"),
		processEvidencePath: join(tempRoot, "processes.json"),
		showWindow: false,
	};
	const home = join(tempRoot, "home");
	await Promise.all([config.stateHome, config.userDataPath, config.projectPath, home].map((path) => mkdir(path)));
	await mkdir(join(home, ".codex", "sessions"), { recursive: true });
	await writeFile(config.hostSimulationConfigPath, "{}");
	const configPath = join(tempRoot, "config.json");
	await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
	const appPath = join(tempRoot, "Quarterdeck Ω.app");
	const result: DesktopLabFixture = {
		config,
		configPath,
		environment: {
			HOME: home,
			TMPDIR: tempRoot,
			QUARTERDECK_AGENT_LAB: "1",
			QUARTERDECK_DESKTOP_LAB_CONFIG: configPath,
			QUARTERDECK_STATE_HOME: config.stateHome,
			QUARTERDECK_AGENT_LAB_FAKE_AGENT: join(tempRoot, "fake-codex.ts"),
		},
		manifestPath: join(tempRoot, "manifest.json"),
		forbiddenHostLaunchLogPath: join(tempRoot, "forbidden.log"),
		keepTemp: false,
		manifest: {
			schemaVersion: 1,
			surface: "electron",
			runId: "main-loss-test",
			status: "ready",
			appPath,
			executablePath: `${appPath}/Contents/MacOS/Quarterdeck`,
			artifactDir: tempRoot,
			tempRoot,
			stateHome: config.stateHome,
			userDataPath: config.userDataPath,
			projectPath: config.projectPath,
			showWindow: false,
			agent: { mode: "fake" },
			providerVersion: null,
			mainPid: 100,
			helperPid: 101,
			rendererPids: [],
			processes: [],
			remainingPids: [],
			createdAt: "synthetic",
			stoppedAt: null,
			failure: null,
		},
	};
	await seedHistory(result);
	return result;
}

function historyPath(input: DesktopLabFixture): string {
	return join(input.environment.HOME ?? "", ".codex", "sessions", "rollout-agent-lab-task.jsonl");
}

async function seedHistory(input: DesktopLabFixture): Promise<void> {
	await writeFile(
		historyPath(input),
		[
			JSON.stringify({ type: "session_meta", payload: { id: "agent-lab-task" } }),
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: desktopMainLossHistoryMarker(input, "task") }],
				},
			}),
			"",
		].join("\n"),
	);
}

function session(pid = 102, sessionInstanceId = "launch-before") {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "task",
		agentId: "codex",
		sessionInstanceId,
		resumeSessionId: "agent-lab-task",
		state: "awaiting_review",
		pid,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		recentProviderHookOrderObservations: [
			{
				event: "activity",
				deliveryId: "22222222-2222-4222-8222-222222222222",
				occurredAt: 2,
				source: "codex",
				sessionInstanceId,
				providerSessionId: "agent-lab-task",
				hookEventName: "SessionStart",
				notificationType: null,
				turnId: null,
				promptId: null,
				toolUseId: null,
				elicitationId: null,
				toolName: null,
			},
		],
	});
}

function scenario(input: DesktopLabFixture) {
	const main: DesktopLabProcess = {
		pid: 100,
		parentPid: process.pid,
		startedAt: "main-before",
		command: `${input.manifest.executablePath} --user-data-dir=${input.config.userDataPath}`,
	};
	const helper = {
		pid: 101,
		parentPid: 100,
		startedAt: "helper-before",
		command: `${input.manifest.appPath}/Contents/Resources/runtime/bin/node cli.js ${input.config.hostSimulationConfigPath}`,
	};
	const provider = {
		pid: 102,
		parentPid: 101,
		startedAt: "provider-before",
		command: `node tsx-cli ${input.environment.QUARTERDECK_AGENT_LAB_FAKE_AGENT}`,
	};
	const processes = [main, helper, provider];
	input.manifest.processes = [...processes];
	const evidence: DesktopProcessEvidence = {
		version: 1,
		appPid: main.pid,
		helperPid: helper.pid,
		generation: "generation-before",
		runtimeOrigin: "http://127.0.0.1:3501",
		phase: "ready",
	};
	const owner: DesktopMainLossOwner = {
		generation: evidence.generation ?? "",
		canonicalStateHome: input.config.stateHome,
		pid: helper.pid,
		creationIdentity: "exact-helper-identity",
		processState: "live",
		released: false,
	};
	let signalled = false;
	const signalMain = vi.fn((_pid: number, _signal: "SIGKILL") => {
		signalled = true;
	});
	const invocation: FakeInvocationReceipt = {
		version: 1,
		provider: "codex",
		taskId: "task",
		sessionInstanceId: "launch-before",
		pid: provider.pid,
		providerSessionId: "agent-lab-task",
		resumeKind: "fresh",
		requestedSessionId: null,
		historyPresent: true,
	};
	const options = {
		taskId: "task",
		session: session(),
		readEvidence: async () => ({ ...evidence }),
		readInvocation: async () => ({ ...invocation }),
		readOwner: async () =>
			({ ...owner, released: signalled, processState: signalled ? "dead" : "live" }) as DesktopMainLossOwner,
		listProcesses: async () => (signalled ? [] : processes),
		signalMain,
		timeoutMs: 200,
		pollIntervalMs: 1,
	};
	return {
		options,
		signalMain,
		main,
		helper,
		provider,
		processes,
		evidence,
		owner,
		invocation,
		signalled: () => signalled,
	};
}

function recovered(input: DesktopLabFixture, before: DesktopMainLossProof): DesktopMainLossRecovery {
	const main = { ...before.main, pid: 200, startedAt: "main-after" };
	const helper = { ...before.helper, pid: 201, parentPid: main.pid, startedAt: "helper-after" };
	const provider = { ...before.provider, pid: 202, parentPid: helper.pid, startedAt: "provider-after" };
	const worker = { ...provider, pid: 203, parentPid: provider.pid, startedAt: "worker-after" };
	input.manifest.mainPid = main.pid;
	input.manifest.helperPid = helper.pid;
	input.manifest.processes = [main, helper, provider, worker];
	const summary = session(provider.pid, "launch-after");
	const hook = summary.recentProviderHookOrderObservations[0];
	if (!hook) throw new Error("Missing synthetic startup hook.");
	hook.deliveryId = "33333333-3333-4333-8333-333333333333";
	return {
		fixture: input,
		processes: input.manifest.processes,
		evidence: {
			version: 1,
			appPid: main.pid,
			helperPid: helper.pid,
			generation: "generation-after",
			runtimeOrigin: "http://127.0.0.1:3502",
			phase: "ready",
		},
		session: summary,
		owner: {
			...before.ownershipBefore,
			generation: "generation-after",
			pid: helper.pid,
			creationIdentity: "new-exact-helper-identity",
		},
		history: { ...before.history },
		invocation: {
			version: 1,
			provider: "codex",
			taskId: "task",
			sessionInstanceId: "launch-after",
			pid: worker.pid,
			providerSessionId: "agent-lab-task",
			resumeKind: "targeted",
			requestedSessionId: "agent-lab-task",
			historyPresent: true,
		},
	};
}

describe("exact owned packaged main process loss", () => {
	it("signals only the captured SDK-parented main and requires clean lease release plus natural forest drain", async () => {
		const input = await fixture();
		const test = scenario(input);
		const list = vi
			.fn()
			.mockResolvedValueOnce(test.processes)
			.mockResolvedValueOnce(test.processes)
			.mockResolvedValue([]);
		const proof = await proveDesktopMainProcessLoss(input, { ...test.options, listProcesses: list });
		expect(test.signalMain).toHaveBeenCalledExactlyOnceWith(test.main.pid, "SIGKILL");
		expect(proof).toMatchObject({
			main: test.main,
			helper: test.helper,
			provider: test.provider,
			providerWorker: test.provider,
			invocation: test.invocation,
			ownershipAfter: { generation: "generation-before", released: true, processState: "dead" },
			remainingProcesses: [],
			fallbackUsed: false,
		});
		expect(await readDesktopMainLossHistory(input, "task")).toEqual(proof.history);
	});

	it("captures a distinct TSX worker receipt and refuses its reused birth before signalling the main", async () => {
		const input = await fixture();
		const test = scenario(input);
		const worker = { ...test.provider, pid: 103, parentPid: test.provider.pid, startedAt: "worker-before" };
		const processes = [...test.processes, worker];
		const invocation = { ...test.invocation, pid: worker.pid };
		const readInvocation = vi.fn().mockResolvedValue(invocation);
		const list = vi.fn().mockResolvedValueOnce(processes).mockResolvedValueOnce(processes).mockResolvedValue([]);
		const proof = await proveDesktopMainProcessLoss(input, { ...test.options, readInvocation, listProcesses: list });
		expect(readInvocation).toHaveBeenCalledExactlyOnceWith("launch-before");
		expect(proof.providerWorker).toEqual(worker);
		expect(proof.ownedProcesses).toContainEqual(worker);

		const freshInput = await fixture();
		const freshTest = scenario(freshInput);
		const freshWorker = { ...worker, command: freshTest.provider.command };
		const freshProcesses = [...freshTest.processes, freshWorker];
		const changedList = vi
			.fn()
			.mockResolvedValueOnce(freshProcesses)
			.mockResolvedValue([...freshTest.processes, { ...freshWorker, startedAt: "unrelated-reused-birth" }]);
		await expect(
			proveDesktopMainProcessLoss(freshInput, {
				...freshTest.options,
				readInvocation: async () => ({ ...freshTest.invocation, pid: freshWorker.pid }),
				listProcesses: changedList,
			}),
		).rejects.toMatchObject({ mainSignalled: false });
		expect(freshTest.signalMain).not.toHaveBeenCalled();
	});

	it.each(["missing", "wrong-launch", "metadata-worker"])(
		"refuses inadequate initial fake invocation evidence before signalling: %s",
		async (kind) => {
			const input = await fixture();
			const test = scenario(input);
			if (kind === "metadata-worker") test.provider.command += " app-server";
			const readInvocation = async () =>
				kind === "missing"
					? null
					: { ...test.invocation, sessionInstanceId: kind === "wrong-launch" ? "stale-launch" : "launch-before" };
			await expect(proveDesktopMainProcessLoss(input, { ...test.options, readInvocation })).rejects.toMatchObject({
				mainSignalled: false,
			});
			expect(test.signalMain).not.toHaveBeenCalled();
		},
	);

	it("retains reparented helpers and late descendants while excluding reused unrelated PIDs", async () => {
		const input = await fixture();
		const test = scenario(input);
		const lateChild = { pid: 103, parentPid: 102, startedAt: "late-child", command: "synthetic child" };
		const reusedMain = { ...test.main, startedAt: "unrelated-birth", command: "unrelated application" };
		const unrelatedChild = { ...lateChild, pid: 104, parentPid: reusedMain.pid, command: "unrelated child" };
		const list = vi
			.fn()
			.mockResolvedValueOnce(test.processes)
			.mockResolvedValueOnce(test.processes)
			.mockResolvedValueOnce([
				{ ...test.helper, parentPid: 1 },
				test.provider,
				lateChild,
				reusedMain,
				unrelatedChild,
			])
			.mockResolvedValue([reusedMain, unrelatedChild]);
		const proof = await proveDesktopMainProcessLoss(input, { ...test.options, listProcesses: list });
		expect(proof.ownedProcesses).toContainEqual(lateChild);
		expect(proof.ownedProcesses.some((item) => item.command.startsWith("unrelated"))).toBe(false);
		expect(test.signalMain).toHaveBeenCalledExactlyOnceWith(test.main.pid, "SIGKILL");
	});

	it.each(["not-captured", "marker-missing", "different-parent", "reused-before-signal", "helper-left"])(
		"refuses unverified main-loss authority: %s",
		async (kind) => {
			const input = await fixture();
			const test = scenario(input);
			if (kind === "not-captured") input.manifest.processes = [];
			if (kind === "marker-missing") {
				test.main.command = `${input.manifest.executablePath} ${input.config.hostSimulationConfigPath}`;
			}
			if (kind === "different-parent") test.main.parentPid = 1;
			const fresh =
				kind === "reused-before-signal"
					? [{ ...test.main, startedAt: "reused" }, test.helper, test.provider]
					: kind === "helper-left"
						? [test.main, test.provider]
						: test.processes;
			const list = vi.fn().mockResolvedValueOnce(test.processes).mockResolvedValue(fresh);
			await expect(
				proveDesktopMainProcessLoss(input, { ...test.options, listProcesses: list }),
			).rejects.toBeInstanceOf(DesktopMainLossError);
			expect(test.signalMain).not.toHaveBeenCalled();
		},
	);

	it.each(["missing", "different-generation", "unreleased-dead", "released-unknown", "survivor"])(
		"never accepts incomplete parent-loss cleanup: %s",
		async (kind) => {
			const input = await fixture();
			const test = scenario(input);
			const readOwner = async (): Promise<DesktopMainLossOwner | null> => {
				if (!test.signalled()) return test.owner;
				if (kind === "missing") return null;
				return {
					...test.owner,
					generation: kind === "different-generation" ? "unexpected-new-generation" : test.owner.generation,
					released: kind !== "unreleased-dead",
					processState: kind === "released-unknown" ? "unknown" : "dead",
				};
			};
			const list = async () =>
				!test.signalled() ? test.processes : kind === "survivor" ? [{ ...test.provider, parentPid: 1 }] : [];
			await expect(
				proveDesktopMainProcessLoss(input, { ...test.options, readOwner, listProcesses: list, timeoutMs: 30 }),
			).rejects.toMatchObject({ mainSignalled: true });
			expect(test.signalMain).toHaveBeenCalledExactlyOnceWith(test.main.pid, "SIGKILL");
		},
	);

	it("bounds an unresponsive pre-signal identity query and never signals after its late resolution", async () => {
		const input = await fixture();
		const test = scenario(input);
		let finish: ((processes: DesktopLabProcess[]) => void) | undefined;
		const query = new Promise<DesktopLabProcess[]>((resolve) => {
			finish = resolve;
		});
		await expect(
			proveDesktopMainProcessLoss(input, { ...test.options, listProcesses: () => query, timeoutMs: 20 }),
		).rejects.toMatchObject({ mainSignalled: false });
		finish?.(test.processes);
		await Promise.resolve();
		expect(test.signalMain).not.toHaveBeenCalled();
	});

	it("fails a post-signal process inspection without substituting cleanup signals or changing state", async () => {
		const input = await fixture();
		const test = scenario(input);
		const list = vi
			.fn()
			.mockResolvedValueOnce(test.processes)
			.mockResolvedValueOnce(test.processes)
			.mockRejectedValue(new Error("inspection unavailable"));
		await expect(proveDesktopMainProcessLoss(input, { ...test.options, listProcesses: list })).rejects.toMatchObject({
			mainSignalled: true,
			ownedProcesses: test.processes,
		});
		expect(test.signalMain).toHaveBeenCalledTimes(1);
		expect(await readDesktopMainLossHistory(input, "task")).toMatchObject({ bytes: expect.any(Number) });
	});

	it("reads only the exact seeded bounded fixture-local history and does not expose transcript content", async () => {
		const input = await fixture();
		const history = await readDesktopMainLossHistory(input, "task");
		expect(history.sha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(JSON.stringify(history)).not.toContain("desktop-main-loss");
		await writeFile(historyPath(input), JSON.stringify({ type: "session_meta", payload: { id: "agent-lab-task" } }));
		await expect(readDesktopMainLossHistory(input, "task")).rejects.toThrow("seeded");
		await writeFile(historyPath(input), "x".repeat(2 * 1024 * 1024 + 1));
		await expect(readDesktopMainLossHistory(input, "task")).rejects.toThrow("bound");
	});

	it("refuses symlinked history outside the synthetic fixture", async () => {
		const input = await fixture();
		const other = await realpath(await mkdtemp(join(tmpdir(), "quarterdeck-main-loss-other-")));
		roots.push(other);
		const external = join(other, "history.jsonl");
		await writeFile(external, "synthetic external file");
		await rm(historyPath(input));
		await symlink(external, historyPath(input));
		await expect(readDesktopMainLossHistory(input, "task")).rejects.toThrow("symlink");
	});

	it("projects ownership metadata without returning its authenticated descriptor", async () => {
		vi.mocked(discoverRuntimeOwner).mockResolvedValue({
			claim: {
				generation: "generation",
				canonicalStateHome: "/synthetic-state",
				process: { pid: 101, creationIdentity: "creation" },
			},
			descriptor: { managementToken: "must-not-be-exported" },
			processState: "dead",
			released: true,
		} as unknown as NonNullable<Awaited<ReturnType<typeof discoverRuntimeOwner>>>);
		expect(await readDesktopMainLossOwner("/synthetic-state")).toEqual({
			generation: "generation",
			canonicalStateHome: "/synthetic-state",
			pid: 101,
			creationIdentity: "creation",
			processState: "dead",
			released: true,
		});
	});
});

describe("packaged fake recovery after main process loss", () => {
	it("retains a copied fixture identity and rejects rewritten valid userData config at the same state home", async () => {
		const input = await fixture();
		const test = scenario(input);
		const before = await proveDesktopMainProcessLoss(input, test.options);
		const retainedUserData = input.config.userDataPath;
		const after = recovered(input, before);
		const replacementUserData = join(input.config.tempRoot, "replacement user data");
		await mkdir(replacementUserData);
		input.config.userDataPath = replacementUserData;
		input.manifest.userDataPath = replacementUserData;
		await writeFile(input.configPath, JSON.stringify(input.config), { mode: 0o600 });
		const main = after.processes.find((item) => item.pid === input.manifest.mainPid);
		if (!main) throw new Error("Missing replacement main.");
		main.command = `${input.manifest.executablePath} --user-data-dir=${replacementUserData}`;
		expect(Object.isFrozen(before.fixtureIdentity)).toBe(true);
		expect(before.fixtureIdentity.userDataPath).toBe(retainedUserData);
		expect(before.fixtureIdentity.stateHome).toBe(after.owner?.canonicalStateHome);
		expect(() => assertDesktopMainLossRecovery(before, after)).toThrow("exact retained fixture");
	});

	it.each(["run", "history-home"])("rejects replacement fixture identity drift: %s", async (kind) => {
		const input = await fixture();
		const test = scenario(input);
		const before = await proveDesktopMainProcessLoss(input, test.options);
		const after = recovered(input, before);
		if (kind === "run") input.manifest.runId = "replacement-run";
		else input.environment.HOME = join(input.config.tempRoot, "replacement home");
		expect(() => assertDesktopMainLossRecovery(before, after)).toThrow("exact retained fixture");
	});

	it("requires targeted invocation and unchanged history while counting a nested TSX worker as one provider", async () => {
		const input = await fixture();
		const test = scenario(input);
		const before = await proveDesktopMainProcessLoss(input, test.options);
		const after = recovered(input, before);
		const proof = assertDesktopMainLossRecovery(before, after);
		expect(proof).toMatchObject({
			generation: "generation-after",
			session: { providerSessionId: before.session.providerSessionId, sessionInstanceId: "launch-after" },
			invocation: { resumeKind: "targeted", requestedSessionId: "agent-lab-task", historyPresent: true },
		});
	});

	it.each(["missing", "fresh-deterministic-id", "wrong-session", "old-launch", "missing-history", "unowned-pid"])(
		"rejects inadequate provider invocation evidence: %s",
		async (kind) => {
			const input = await fixture();
			const test = scenario(input);
			const before = await proveDesktopMainProcessLoss(input, test.options);
			const after = recovered(input, before);
			const receipt = after.invocation;
			if (!receipt) throw new Error("Missing synthetic invocation.");
			if (kind === "missing") after.invocation = null;
			if (kind === "fresh-deterministic-id")
				after.invocation = { ...receipt, resumeKind: "fresh", requestedSessionId: null };
			if (kind === "wrong-session")
				after.invocation = {
					...receipt,
					providerSessionId: "agent-lab-other",
					requestedSessionId: "agent-lab-other",
				};
			if (kind === "old-launch")
				after.invocation = { ...receipt, sessionInstanceId: before.session.sessionInstanceId };
			if (kind === "missing-history") after.invocation = { ...receipt, historyPresent: false };
			if (kind === "unowned-pid") after.invocation = { ...receipt, pid: 999 };
			expect(() => assertDesktopMainLossRecovery(before, after)).toThrow(/receipt/u);
		},
	);

	it.each(["generation", "old-hook", "history", "old-survivor", "duplicate-provider", "claim"])(
		"rejects incomplete main-loss recovery: %s",
		async (kind) => {
			const input = await fixture();
			const test = scenario(input);
			const before = await proveDesktopMainProcessLoss(input, test.options);
			const after = recovered(input, before);
			if (kind === "generation") after.evidence.generation = before.ownershipBefore.generation;
			if (kind === "old-hook")
				after.session.recentProviderHookOrderObservations =
					test.options.session.recentProviderHookOrderObservations;
			if (kind === "history") after.history.sha256 = "different";
			if (kind === "old-survivor") after.processes.push({ ...before.provider, parentPid: 1 });
			if (kind === "duplicate-provider")
				after.processes.push({
					...before.provider,
					pid: 204,
					parentPid: after.evidence.helperPid ?? 0,
					startedAt: "duplicate",
				});
			if (kind === "claim") after.owner = null;
			expect(() => assertDesktopMainLossRecovery(before, after)).toThrow("Main-loss recovery");
		},
	);

	it("does not count the fixed metadata app-server branch or unrelated fake-script processes as task duplicates", async () => {
		const input = await fixture();
		const test = scenario(input);
		const before = await proveDesktopMainProcessLoss(input, test.options);
		const after = recovered(input, before);
		after.processes.push(
			{
				...before.provider,
				pid: 204,
				parentPid: 201,
				startedAt: "catalog",
				command: `${before.provider.command} app-server`,
			},
			{ ...before.provider, pid: 205, parentPid: 1, startedAt: "unrelated" },
		);
		expect(assertDesktopMainLossRecovery(before, after).provider.pid).toBe(202);
	});

	it("counts a sibling TUI with app-server text in an option as a duplicate rather than metadata RPC", async () => {
		const input = await fixture();
		const test = scenario(input);
		const before = await proveDesktopMainProcessLoss(input, test.options);
		const after = recovered(input, before);
		after.processes.push({
			...before.provider,
			pid: 204,
			parentPid: 201,
			startedAt: "duplicate",
			command: `${before.provider.command} --message app-server`,
		});
		expect(() => assertDesktopMainLossRecovery(before, after)).toThrow("exactly one");
	});
});
