import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as nodeFs from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopLabDriver } from "../../../scripts/agent-lab/desktop-driver";
import {
	parseDesktopProviderVersion,
	validateDesktopProviderSelection,
} from "../../../scripts/agent-lab/desktop-provider";
import {
	assertDesktopCodexResumeDecision,
	assertDesktopCodexResumeIdentity,
	assertDesktopExactRecovery,
	captureDesktopRealTimeoutWindow,
	DESKTOP_CODEX_RESUME_TURN,
	DESKTOP_REAL_PROVIDER_MENU_NAMES,
	type DesktopCodexResumeCheckpoint,
	desktopRealApprovalPrompt,
	hasDesktopCodexResumeHooks,
	observeDesktopCodexResumeOutput,
	projectDesktopRealSession,
	type readDesktopCodexResumeDocument,
	restartDesktopCodexWithResumeObservation,
	runDesktopCodexResumeTurn,
	waitDesktopCodexResumeQuiet,
	waitForSession,
} from "../../../scripts/agent-lab/desktop-real-scenario";
import { readDesktopTaskSession } from "../../../scripts/agent-lab/desktop-session-evidence";
import { writeJsonAtomic } from "../../../scripts/agent-lab/paths";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api/task-session";

vi.mock("../../../scripts/agent-lab/desktop-session-evidence", () => ({ readDesktopTaskSession: vi.fn() }));
vi.mock("../../../scripts/agent-lab/paths", () => ({ writeJsonAtomic: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof nodeFs>()),
	writeFile: vi.fn(),
}));

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(writeJsonAtomic).mockResolvedValue(undefined);
	vi.mocked(writeFile).mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

function summary(launch: string, providerId = "provider-session") {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "task",
		agentId: "codex",
		sessionInstanceId: launch,
		resumeSessionId: providerId,
		state: "running",
		pid: 50000,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		latestHookActivity: { finalMessage: "private transcript", transcriptPath: "/private/session" },
		recentProviderHookOrderObservations: [
			{
				event: "to_in_progress",
				deliveryId: "11111111-1111-4111-8111-111111111111",
				occurredAt: 1,
				source: "codex",
				sessionInstanceId: "old-launch",
				hookEventName: "userPromptSubmit",
				notificationType: null,
				turnId: null,
				promptId: null,
				toolUseId: null,
				elicitationId: null,
				toolName: null,
			},
			{
				event: "activity",
				deliveryId: "22222222-2222-4222-8222-222222222222",
				occurredAt: 2,
				source: "codex",
				sessionInstanceId: launch,
				hookEventName: "sessionStart",
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

function session(launch: string, providerId = "provider-session") {
	const current = summary(launch, providerId);
	current.recentProviderHookOrderObservations.push({
		...current.recentProviderHookOrderObservations[1],
		event: "to_in_progress",
		hookEventName: "UserPromptSubmit",
		deliveryId: "33333333-3333-4333-8333-333333333333",
	});
	return projectDesktopRealSession(current);
}

function timeoutFixture() {
	const expected = {
		mainPid: process.pid,
		executablePath: "/synthetic/Quarterdeck.app/Contents/MacOS/Quarterdeck",
		appPath: "/synthetic/Quarterdeck.app/Contents/Resources/app.asar",
		userDataPath: "/synthetic/user-data",
		url: "app://quarterdeck/Projects/fixture",
		maxPngBytes: 8 * 1024 * 1024,
	};
	const capturePage = vi.fn(async () => ({
		isEmpty: () => false,
		getSize: () => ({ width: 1000, height: 700 }),
		toPNG: vi.fn(() => Buffer.from("synthetic PNG bytes")),
	}));
	const native = {
		app: {
			isPackaged: true,
			getAppPath: () => expected.appPath,
			getPath: (name: "exe" | "userData") => (name === "exe" ? expected.executablePath : expected.userDataPath),
		},
		BrowserWindow: {
			getAllWindows: () => [
				{
					id: 1,
					webContents: {
						id: 2,
						getURL: () => expected.url,
						getOSProcessId: () => 3,
						capturePage,
					},
				},
			],
		},
	};
	const evaluate = vi.fn(async (capture: typeof captureDesktopRealTimeoutWindow, identity: typeof expected) =>
		capture(native, identity),
	);
	const driver = {
		fixture: {
			config: { stateHome: "/synthetic/state", userDataPath: expected.userDataPath },
			manifest: {
				mainPid: expected.mainPid,
				executablePath: expected.executablePath,
				appPath: "/synthetic/Quarterdeck.app",
				artifactDir: "/synthetic/evidence",
			},
		},
		app: { evaluate },
		inspect: vi.fn(async () => {}),
	} as unknown as DesktopLabDriver;
	const page = { url: () => expected.url } as Page;
	return { driver, page, expected, native, capturePage, evaluate };
}

describe("bounded real-provider timeout evidence", () => {
	const nativeWork = (current: ReturnType<typeof session>) =>
		current.agentId === "codex" && current.hooks.some((hook) => hook.event === "to_in_progress");

	it("distinguishes a missing session and retains metadata plus one hidden-safe screenshot before inspection", async () => {
		vi.useFakeTimers();
		const fixture = timeoutFixture();
		vi.mocked(readDesktopTaskSession).mockResolvedValue(null);
		vi.mocked(fixture.driver.inspect).mockImplementation(async () => {
			expect(writeJsonAtomic).toHaveBeenCalledOnce();
			expect(writeFile).toHaveBeenCalledOnce();
		});
		const checking = waitForSession(fixture.driver, "task", "native-work", nativeWork, 60_000, fixture.page).catch(
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(60_200);
		expect(await checking).toEqual(
			expect.objectContaining({
				message: "Real provider scenario inconclusive: no native-work within 60000ms; no approval was sent.",
			}),
		);
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/real-native-work-timeout.json",
			expect.objectContaining({
				stage: "wait_for_session",
				label: "native-work",
				timeoutMs: 60_000,
				latest: null,
				lastPollStatus: "missing",
				finalRead: { status: "missing" },
				approved: false,
				screenshot: expect.objectContaining({ status: "captured", file: "real-native-work-timeout.png" }),
			}),
		);
		expect(fixture.capturePage).toHaveBeenCalledExactlyOnceWith(undefined, { stayHidden: true, stayAwake: false });
	});

	it("retains current SessionStart without accepting stale-launch work as native work", async () => {
		vi.useFakeTimers();
		const fixture = timeoutFixture();
		vi.mocked(readDesktopTaskSession).mockResolvedValue(summary("current-launch"));
		const checking = waitForSession(fixture.driver, "task", "native-work", nativeWork, 60_000, fixture.page).catch(
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(60_200);
		expect(await checking).toEqual(expect.objectContaining({ message: expect.stringContaining("no native-work") }));
		const receipt = vi.mocked(writeJsonAtomic).mock.calls[0][1];
		expect(receipt).toMatchObject({
			lastPollStatus: "present",
			latest: {
				observedAt: expect.any(String),
				session: {
					sessionInstanceId: "current-launch",
					hooks: [{ event: "activity", hookEventName: "sessionStart" }],
				},
			},
			finalRead: { status: "present", session: { sessionInstanceId: "current-launch" } },
		});
		for (const privateValue of ["private transcript", "/private/session", "old-launch"])
			expect(JSON.stringify(receipt)).not.toContain(privateValue);
	});

	it("keeps the last present projection separate from a later missing poll and final read", async () => {
		vi.useFakeTimers();
		const fixture = timeoutFixture();
		vi.mocked(readDesktopTaskSession).mockResolvedValueOnce(summary("current-launch")).mockResolvedValue(null);
		const checking = waitForSession(fixture.driver, "task", "native-work", nativeWork, 60_000, fixture.page).catch(
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(60_200);
		await checking;
		expect(vi.mocked(writeJsonAtomic).mock.calls[0][1]).toMatchObject({
			latest: { session: { sessionInstanceId: "current-launch" } },
			lastPollStatus: "missing",
			finalRead: { status: "missing" },
		});
	});

	it("accepts current-launch work promptly and performs no timeout capture", async () => {
		const fixture = timeoutFixture();
		const current = summary("current-launch");
		current.recentProviderHookOrderObservations[1].event = "to_in_progress";
		vi.mocked(readDesktopTaskSession).mockResolvedValue(current);
		expect(
			await waitForSession(fixture.driver, "task", "native-work", nativeWork, 60_000, fixture.page),
		).toMatchObject({ hooks: [{ event: "to_in_progress" }] });
		expect(fixture.evaluate).not.toHaveBeenCalled();
		expect(writeJsonAtomic).not.toHaveBeenCalled();
	});

	it("does not treat work first seen in the final diagnostic read as success after the deadline", async () => {
		vi.useFakeTimers();
		const fixture = timeoutFixture();
		const startedAt = Date.now();
		const working = summary("current-launch");
		working.recentProviderHookOrderObservations[1].event = "to_in_progress";
		vi.mocked(readDesktopTaskSession).mockImplementation(async () =>
			Date.now() < startedAt + 60_000 ? summary("current-launch") : working,
		);
		const checking = waitForSession(fixture.driver, "task", "native-work", nativeWork, 60_000, fixture.page).catch(
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(60_200);
		expect(await checking).toEqual(expect.objectContaining({ message: expect.stringContaining("no native-work") }));
		expect(vi.mocked(writeJsonAtomic).mock.calls[0][1]).toMatchObject({
			finalRead: { status: "present", session: { hooks: [{ event: "to_in_progress" }] } },
		});
	});

	it.each([
		"read",
		"read-stall",
		"capture",
		"capture-stall",
		"png-write",
		"png-write-stall",
		"json-write",
		"json-write-stall",
		"json-write-sync",
		"inspect",
		"inspect-stall",
	] as const)("preserves the original timeout and cleanup path after diagnostic %s failure", async (failure) => {
		vi.useFakeTimers();
		const fixture = timeoutFixture();
		const startedAt = Date.now();
		vi.mocked(readDesktopTaskSession).mockImplementation(async () => {
			if (Date.now() >= startedAt + 60_000) {
				if (failure === "read") throw new Error("private read failure");
				if (failure === "read-stall") return new Promise(() => {});
			}
			return summary("current-launch");
		});
		if (failure === "capture") fixture.evaluate.mockRejectedValue(new Error("private capture failure"));
		if (failure === "capture-stall") fixture.evaluate.mockImplementation(() => new Promise(() => {}));
		if (failure === "png-write") vi.mocked(writeFile).mockRejectedValue(new Error("private PNG write failure"));
		if (failure === "png-write-stall") vi.mocked(writeFile).mockImplementation(() => new Promise(() => {}));
		if (failure === "json-write")
			vi.mocked(writeJsonAtomic).mockRejectedValue(new Error("private JSON write failure"));
		if (failure === "json-write-stall") vi.mocked(writeJsonAtomic).mockImplementation(() => new Promise(() => {}));
		if (failure === "json-write-sync")
			vi.mocked(writeJsonAtomic).mockImplementation(() => {
				throw new Error("private JSON write failure");
			});
		if (failure === "inspect")
			vi.mocked(fixture.driver.inspect).mockImplementation(() => {
				throw new Error("private inspect failure");
			});
		if (failure === "inspect-stall")
			vi.mocked(fixture.driver.inspect).mockImplementation(() => new Promise(() => {}));
		let cleanupReached = false;
		const checking = waitForSession(fixture.driver, "task", "native-work", nativeWork, 60_000, fixture.page)
			.catch((error) => error)
			.finally(() => {
				cleanupReached = true;
			});
		await vi.advanceTimersByTimeAsync(70_000);
		expect(await checking).toEqual(
			expect.objectContaining({
				message: "Real provider scenario inconclusive: no native-work within 60000ms; no approval was sent.",
			}),
		);
		expect(cleanupReached).toBe(true);
		const receipt = vi.mocked(writeJsonAtomic).mock.calls[0][1];
		expect(JSON.stringify(receipt)).not.toContain("private");
		if (failure.startsWith("read")) expect(receipt).toMatchObject({ finalRead: { status: "unavailable" } });
		if (failure.startsWith("capture") || failure.startsWith("png-write"))
			expect(receipt).toMatchObject({ screenshot: { status: "unavailable", reason: "capture_unconfirmed" } });
	});
});

describe("native timeout capture serialization and exact window boundary", () => {
	it("executes the actual TSX-transformed capture callback in a fresh main-process realm without module helpers", async () => {
		const child = await promisify(execFile)(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				'import { captureDesktopRealTimeoutWindow } from "./scripts/agent-lab/desktop-real-scenario.ts"; process.stdout.write(captureDesktopRealTimeoutWindow.toString());',
			],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 },
		);
		const fixture = timeoutFixture();
		const globals = { process: { pid: fixture.expected.mainPid } };
		expect(runInNewContext("typeof __name", globals)).toBe("undefined");
		expect(child.stdout).not.toContain("__name");
		const capture = runInNewContext(`(${child.stdout})`, globals, {
			timeout: 1_000,
		}) as typeof captureDesktopRealTimeoutWindow;
		expect(await capture(fixture.native, fixture.expected)).toMatchObject({
			windowId: 1,
			webContentsId: 2,
			rendererPid: 3,
		});
		expect(fixture.capturePage).toHaveBeenCalledExactlyOnceWith(undefined, { stayHidden: true, stayAwake: false });
	}, 15_000);

	it.each(["mainPid", "executablePath", "appPath", "userDataPath", "url"] as const)(
		"refuses a mismatched owned %s before native capture",
		async (field) => {
			const fixture = timeoutFixture();
			const expected = { ...fixture.expected };
			if (field === "mainPid") expected.mainPid += 1;
			else expected[field] = "/another/identity";
			await expect(captureDesktopRealTimeoutWindow(fixture.native, expected)).rejects.toThrow("refused another");
			expect(fixture.capturePage).not.toHaveBeenCalled();
		},
	);

	it("refuses multiple windows and bounds PNG bytes before crossing the bridge", async () => {
		const fixture = timeoutFixture();
		const window = fixture.native.BrowserWindow.getAllWindows()[0];
		fixture.native.BrowserWindow.getAllWindows = () => [window, window];
		await expect(captureDesktopRealTimeoutWindow(fixture.native, fixture.expected)).rejects.toThrow(
			"refused another",
		);
		expect(fixture.capturePage).not.toHaveBeenCalled();
		fixture.native.BrowserWindow.getAllWindows = () => [window];
		await expect(
			captureDesktopRealTimeoutWindow(fixture.native, { ...fixture.expected, maxPngBytes: 1 }),
		).rejects.toThrow("exceeds its bound");
	});
});

describe("desktop real-provider safety and proof boundaries", () => {
	it.each([
		{ agentId: "codex", installed: "OpenAI Codex codex --enable hooks", fallback: "OpenAI Codex" },
		{ agentId: "claude", installed: "Claude Code claude", fallback: "Claude Code" },
	] as const)(
		"requires command metadata before selecting the enabled $agentId row",
		({ agentId, installed, fallback }) => {
			const providerRow = DESKTOP_REAL_PROVIDER_MENU_NAMES[agentId];
			expect(installed).toMatch(providerRow);
			expect(fallback).not.toMatch(providerRow);
			expect(`${fallback} Not available on PATH`).not.toMatch(providerRow);
			expect(`${fallback} Detected provider, but native hook support is unavailable.`).not.toMatch(providerRow);
		},
	);

	it("rejects real --no-agent selections and unknown provider version output", () => {
		expect(() => validateDesktopProviderSelection("real-codex", false)).toThrow("no authentication was accessed");
		expect(() => validateDesktopProviderSelection("real-claude", false)).toThrow("no authentication was accessed");
		expect(() => validateDesktopProviderSelection("fake", false)).not.toThrow();
		expect(parseDesktopProviderVersion("codex", "codex-cli 0.157.0\n")).toBe("0.157.0");
		expect(parseDesktopProviderVersion("claude", "2.1.198 (Claude Code)\n")).toBe("2.1.198");
		expect(parseDesktopProviderVersion("codex", "unrecognized private output 0.157.0")).toBeNull();
	});

	it("requires exact provider identity, a replaced PTY launch, and current-launch native hooks", () => {
		const before = session("first-launch");
		const after = session("second-launch");
		expect(() => assertDesktopExactRecovery(before, after)).not.toThrow();
		expect(() => assertDesktopExactRecovery(before, session("second-launch", "different-provider"))).toThrow(
			"exact provider",
		);
		expect(() => assertDesktopExactRecovery(before, before)).toThrow("PTY launch");
		expect(() => assertDesktopExactRecovery(before, { ...after, hooks: [] })).toThrow("fresh native hook");
		expect(after.hooks).toEqual([
			expect.objectContaining({ event: "activity", hookEventName: "sessionStart" }),
			expect.objectContaining({ event: "to_in_progress", hookEventName: "UserPromptSubmit" }),
		]);
		expect(JSON.stringify(after)).not.toContain("private transcript");
		expect(JSON.stringify(after)).not.toContain("old-launch");
	});

	it("quotes the only synthetic write target and explicitly requires approval", () => {
		const prompt = desktopRealApprovalPrompt("/tmp/synthetic parent's project/proof.txt");
		expect(prompt).toContain("parent'\\''s");
		expect(prompt).toContain("Request permission before running it");
		expect(prompt).toContain("Do not read other files or use network tools");
	});
});

function resumeTurnFixture() {
	const capture = {
		captureSha256: "a".repeat(64),
		outputEpoch: 4,
		documentNonce: "44444444-4444-4444-8444-444444444444",
		windowId: 1,
		webContentsId: 2,
		rendererPid: 3,
	};
	const identity = {
		runId: "run",
		taskId: "task",
		sessionInstanceId: "replacement",
		providerSessionId: "provider",
		pid: 103,
		startedAt: "birth-new",
	};
	const ports = {
		check: vi.fn(async () => {}),
		capture: vi.fn(async () => ({ ...capture })),
		review: vi.fn(
			async (checkpoint: DesktopCodexResumeCheckpoint): Promise<unknown> => ({ ...checkpoint, decision: "accept" }),
		),
		insertText: vi.fn(async (_text: string) => {}),
		enter: vi.fn(async () => {}),
		now: vi.fn(() => 1000),
		isCurrent: vi.fn(() => true),
	};
	return { capture, identity, ports };
}

describe("one-use agent-reviewed Codex resume turn", () => {
	it("inserts only the fixed cancellation text and sends one Enter after distinct visual reviews", async () => {
		const { identity, ports } = resumeTurnFixture();
		const checkpoints = await runDesktopCodexResumeTurn(identity, ports);
		expect(checkpoints.map((item) => item.stage)).toEqual(["before_type", "before_enter"]);
		expect(checkpoints[0].challengeId).not.toBe(checkpoints[1].challengeId);
		expect(checkpoints[0].expectedText).toBeNull();
		expect(checkpoints[1].expectedText).toBe(DESKTOP_CODEX_RESUME_TURN);
		expect(checkpoints.every((item) => item.reviewer === "agent")).toBe(true);
		expect(ports.check).toHaveBeenCalledTimes(6);
		expect(ports.insertText).toHaveBeenCalledExactlyOnceWith(DESKTOP_CODEX_RESUME_TURN);
		expect(ports.enter).toHaveBeenCalledTimes(1);
		expect(ports.review.mock.invocationCallOrder[0]).toBeLessThan(ports.insertText.mock.invocationCallOrder[0]);
		expect(ports.insertText.mock.invocationCallOrder[0]).toBeLessThan(ports.review.mock.invocationCallOrder[1]);
		expect(ports.review.mock.invocationCallOrder[1]).toBeLessThan(ports.enter.mock.invocationCallOrder[0]);
	});

	it.each(["before_type", "before_enter"])("refuses %s without retrying or sending Enter", async (stage) => {
		const { identity, ports } = resumeTurnFixture();
		ports.review.mockImplementation(async (checkpoint) => ({
			...checkpoint,
			decision: checkpoint.stage === stage ? "refuse" : "accept",
		}));
		await expect(runDesktopCodexResumeTurn(identity, ports)).rejects.toThrow("refused");
		expect(ports.insertText).toHaveBeenCalledTimes(stage === "before_type" ? 0 : 1);
		expect(ports.enter).not.toHaveBeenCalled();
	});

	it.each([
		"challengeId",
		"stage",
		"runId",
		"taskId",
		"sessionInstanceId",
		"providerSessionId",
		"pid",
		"startedAt",
		"captureSha256",
		"outputEpoch",
		"documentNonce",
		"windowId",
		"webContentsId",
		"rendererPid",
		"expiresAt",
		"expectedText",
	] as const)("rejects a decision with changed %s", async (field) => {
		const { identity, ports } = resumeTurnFixture();
		const [checkpoint] = await runDesktopCodexResumeTurn(identity, ports);
		const changed = {
			...checkpoint,
			decision: "accept",
			[field]: typeof checkpoint[field] === "number" ? Number(checkpoint[field]) + 1 : "different",
		};
		expect(() => assertDesktopCodexResumeDecision(checkpoint, changed, 1000)).toThrow();
	});

	it("rejects missing, expired, unknown, and replayed decisions", async () => {
		const { identity, ports } = resumeTurnFixture();
		const [first, second] = await runDesktopCodexResumeTurn(identity, ports);
		for (const decision of [
			null,
			{},
			{ ...first, decision: "approve" },
			{ ...first, decision: "accept", extra: true },
		])
			expect(() => assertDesktopCodexResumeDecision(first, decision, 1000)).toThrow();
		expect(() => assertDesktopCodexResumeDecision(first, { ...first, decision: "accept" }, first.expiresAt)).toThrow(
			"expired",
		);
		expect(() => assertDesktopCodexResumeDecision(second, { ...first, decision: "accept" }, 1000)).toThrow(
			"another checkpoint",
		);
	});

	it.each(["captureSha256", "outputEpoch", "documentNonce", "windowId", "webContentsId", "rendererPid"] as const)(
		"refuses changed recaptured %s before inserting anything",
		async (field) => {
			const { identity, ports, capture } = resumeTurnFixture();
			ports.capture.mockResolvedValueOnce(capture).mockResolvedValueOnce({
				...capture,
				[field]: typeof capture[field] === "number" ? Number(capture[field]) + 1 : "changed",
			});
			await expect(runDesktopCodexResumeTurn(identity, ports)).rejects.toThrow("changed during review");
			expect(ports.insertText).not.toHaveBeenCalled();
			expect(ports.enter).not.toHaveBeenCalled();
		},
	);

	it("refuses a final output epoch change or identity-check failure", async () => {
		const first = resumeTurnFixture();
		first.ports.isCurrent.mockReturnValue(false);
		await expect(runDesktopCodexResumeTurn(first.identity, first.ports)).rejects.toThrow("changed before input");
		expect(first.ports.insertText).not.toHaveBeenCalled();
		const second = resumeTurnFixture();
		second.ports.check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("identity changed"));
		await expect(runDesktopCodexResumeTurn(second.identity, second.ports)).rejects.toThrow("identity changed");
		expect(second.ports.insertText).not.toHaveBeenCalled();
	});

	it("rechecks expiry immediately before input", async () => {
		const { identity, ports } = resumeTurnFixture();
		ports.now.mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValueOnce(121000);
		await expect(runDesktopCodexResumeTurn(identity, ports)).rejects.toThrow("expired before input");
		expect(ports.insertText).not.toHaveBeenCalled();
	});

	it("keeps Enter unsent when the typed second challenge changes after its review", async () => {
		const { identity, ports, capture } = resumeTurnFixture();
		ports.capture
			.mockResolvedValueOnce(capture)
			.mockResolvedValueOnce(capture)
			.mockResolvedValueOnce(capture)
			.mockResolvedValueOnce({ ...capture, outputEpoch: capture.outputEpoch + 1 });
		await expect(runDesktopCodexResumeTurn(identity, ports)).rejects.toThrow("changed during review");
		expect(ports.insertText).toHaveBeenCalledExactlyOnceWith(DESKTOP_CODEX_RESUME_TURN);
		expect(ports.review).toHaveBeenCalledTimes(2);
		expect(ports.enter).not.toHaveBeenCalled();
	});

	it("settles expected echo before capture without retrying input", async () => {
		let time = 0;
		const read = () => (time < 100 ? 1 : 2);
		await waitDesktopCodexResumeQuiet(
			read,
			() => time,
			async () => {
				time += 25;
			},
		);
		expect(time).toBe(350);
	});

	it("does not publish first capture after a sparse early quiet gap until two seconds after acquisition", async () => {
		let time = 0;
		await waitDesktopCodexResumeQuiet(
			() => 1,
			() => time,
			async () => {
				time += 25;
			},
			0,
		);
		expect(time).toBe(2000);
	});

	it("settles a later initial restoration burst for one full second before capture", async () => {
		let time = 300;
		const read = () => (time < 1750 ? 1 : 2);
		await waitDesktopCodexResumeQuiet(
			read,
			() => time,
			async () => {
				time += 25;
			},
			0,
		);
		expect(time).toBe(2750);
	});

	it("bounds the first capture quiet wait at ten seconds without weakening subsequent guards", async () => {
		let time = 0;
		await expect(
			waitDesktopCodexResumeQuiet(
				() => Math.floor(time / 500),
				() => time,
				async () => {
					time += 25;
				},
				0,
			),
		).rejects.toThrow("unsettled");
		expect(time).toBe(10000);
	});

	it("refuses never-quiet or lost output observation boundedly", async () => {
		let time = 0;
		await expect(
			waitDesktopCodexResumeQuiet(
				() => time,
				() => time,
				async () => {
					time += 25;
				},
			),
		).rejects.toThrow("unsettled");
		expect(time).toBe(2000);
		await expect(
			waitDesktopCodexResumeQuiet(() => {
				throw new Error("observer lost");
			}),
		).rejects.toThrow("observer lost");
	});
});

function resumeIdentityFixture() {
	const process = (pid: number, parentPid: number) => ({
		pid,
		parentPid,
		startedAt: `birth-${pid}`,
		command: `/synthetic/process-${pid}`,
	});
	const main = process(100, 1),
		helper = process(101, 100),
		old = process(102, 101),
		provider = process(103, 101);
	const before = { ...session("first"), pid: old.pid };
	const replacement = {
		...session("second"),
		pid: provider.pid,
		state: "awaiting_review" as const,
		reviewReason: "interrupted" as const,
	};
	return { before, replacement, owned: { main, helper, old, provider }, processes: [main, helper, provider] };
}

describe("Codex resume exact input boundary", () => {
	it("requires the captured live replacement under the same exact main/helper tree", () => {
		const fixture = resumeIdentityFixture();
		expect(() =>
			assertDesktopCodexResumeIdentity(
				fixture.before,
				fixture.replacement,
				fixture.replacement,
				fixture.owned,
				fixture.processes,
			),
		).not.toThrow();
		for (const processes of [
			fixture.processes.slice(1),
			[...fixture.processes, fixture.owned.old],
			fixture.processes.map((row) => (row.pid === 103 ? { ...row, startedAt: "reused" } : row)),
			fixture.processes.map((row) => (row.pid === 103 ? { ...row, parentPid: 1 } : row)),
		])
			expect(() =>
				assertDesktopCodexResumeIdentity(
					fixture.before,
					fixture.replacement,
					fixture.replacement,
					fixture.owned,
					processes,
				),
			).toThrow("unconfirmed");
	});

	it.each([
		{ agentId: "claude" },
		{ taskId: "other" },
		{ providerSessionId: "different" },
		{ sessionInstanceId: "first" },
		{ pid: 102 },
		{ state: "running" },
		{ reviewReason: "error" },
		{ interactionPresent: true },
		{ interactionWaiting: true },
		{ permissionWaiting: true },
	] as const)("refuses mismatched identity or any current input gate: %j", (change) => {
		const fixture = resumeIdentityFixture();
		const current = { ...fixture.replacement, ...change };
		expect(() =>
			assertDesktopCodexResumeIdentity(
				fixture.before,
				fixture.replacement,
				current,
				fixture.owned,
				fixture.processes,
			),
		).toThrow("unconfirmed");
	});

	it("does not treat old hook deliveries, SessionStart alone, or input intent as resumed work", () => {
		const current = session("second");
		expect(hasDesktopCodexResumeHooks(current)).toBe(true);
		expect(hasDesktopCodexResumeHooks({ ...current, hooks: current.hooks.slice(0, 1) })).toBe(false);
		expect(hasDesktopCodexResumeHooks({ ...current, hooks: current.hooks.slice(1) })).toBe(false);
		expect(
			hasDesktopCodexResumeHooks(
				current,
				current.hooks.map((hook) => hook.deliveryId),
			),
		).toBe(false);
		const raw = summary("second");
		raw.recentProviderHookOrderObservations[1].providerSessionId = "another-session";
		expect(projectDesktopRealSession(raw).hooks).toEqual([]);
	});
});

function outputFixture() {
	const page = Object.assign(new EventEmitter(), { url: () => "app://quarterdeck/project?task=task" });
	const observer = observeDesktopCodexResumeOutput(page as unknown as Page, "task");
	const socket = (path: string, client = "client", project = "project", task = "task") =>
		Object.assign(new EventEmitter(), {
			url: () => `wss://quarterdeck/api/terminal/${path}?taskId=${task}&clientId=${client}&projectId=${project}`,
		});
	const io = socket("io"),
		control = socket("control");
	return {
		page,
		observer,
		socket,
		io,
		control,
		pair() {
			page.emit("websocket", io);
			page.emit("websocket", control);
			observer.bind();
		},
	};
}

describe("passive existing-terminal invalidation", () => {
	it("pairs exact task/project/client existing IO and control, counts frames synchronously, and retires callbacks", () => {
		const fixture = outputFixture();
		fixture.page.emit("websocket", fixture.socket("io", "other", "other", "other"));
		fixture.pair();
		expect(fixture.observer.read()).toBe(0);
		fixture.io.emit("framereceived", { payload: "not parsed" });
		fixture.control.emit("framereceived", { payload: "not parsed" });
		expect(fixture.observer.read()).toBe(2);
		fixture.observer.dispose();
		expect(fixture.page.listenerCount("websocket")).toBe(0);
		expect(fixture.io.listenerCount("framereceived")).toBe(0);
		expect(fixture.control.listenerCount("close")).toBe(0);
	});

	it.each(["close", "socketerror", "replacement", "navigation", "crash"])(
		"refuses %s without adopting another observer",
		(event) => {
			const fixture = outputFixture();
			fixture.pair();
			if (event === "replacement") fixture.page.emit("websocket", fixture.socket("io"));
			else if (event === "navigation") fixture.page.emit("framenavigated");
			else if (event === "crash") fixture.page.emit("crash");
			else fixture.io.emit(event);
			expect(() => fixture.observer.read()).toThrow("unavailable");
			fixture.observer.dispose();
		},
	);

	it.each(["client", "project", "missing"])("rejects %s socket pairing", (kind) => {
		const fixture = outputFixture();
		fixture.page.emit("websocket", fixture.io);
		if (kind !== "missing")
			fixture.page.emit(
				"websocket",
				fixture.socket("control", kind === "client" ? "other" : "client", kind === "project" ? "other" : "project"),
			);
		expect(() => fixture.observer.bind()).toThrow("unavailable");
		fixture.observer.dispose();
	});

	it("listens before Restart constructs replacements while old teardown remains unobserved", async () => {
		const fixture = outputFixture();
		fixture.observer.dispose();
		fixture.page.emit("websocket", fixture.io);
		fixture.page.emit("websocket", fixture.control);
		const io = fixture.socket("io"),
			control = fixture.socket("control");
		const restart = vi.fn(async () => {
			expect(fixture.page.listenerCount("websocket")).toBe(1);
			fixture.io.emit("close");
			fixture.control.emit("close");
			fixture.page.emit("websocket", io);
			fixture.page.emit("websocket", control);
		});
		const observer = await restartDesktopCodexWithResumeObservation(fixture.page as unknown as Page, "task", restart);
		await observer.waitForPair();
		observer.bind();
		expect(observer.read()).toBe(0);
		io.emit("framereceived");
		expect(observer.read()).toBe(1);
		fixture.io.emit("framereceived");
		expect(observer.read()).toBe(1);
		expect(restart).toHaveBeenCalledTimes(1);
		observer.dispose();
	});

	it("waits for a delayed complete pair but never sends or creates sockets", async () => {
		vi.useFakeTimers();
		const fixture = outputFixture();
		fixture.page.emit("websocket", fixture.io);
		const ready = fixture.observer.waitForPair();
		await vi.advanceTimersByTimeAsync(100);
		fixture.page.emit("websocket", fixture.control);
		await vi.advanceTimersByTimeAsync(25);
		expect(await ready).toBe(Date.now() - 25);
		fixture.observer.bind();
		expect(fixture.observer.read()).toBe(0);
		fixture.observer.dispose();
	});

	it("times out a missing pair with a fixed safe category", async () => {
		vi.useFakeTimers();
		const fixture = outputFixture();
		fixture.page.emit("websocket", fixture.io);
		const ready = fixture.observer.waitForPair().catch((error) => error);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await ready).toMatchObject({ message: expect.stringContaining("missing_pair") });
		fixture.observer.dispose();
	});

	it("does not recover closed acquisition by accepting a later replacement", async () => {
		const fixture = outputFixture();
		fixture.page.emit("websocket", fixture.io);
		fixture.io.emit("close");
		fixture.page.emit("websocket", fixture.socket("io"));
		fixture.page.emit("websocket", fixture.control);
		await expect(fixture.observer.waitForPair()).rejects.toThrow("closed_socket");
		fixture.observer.dispose();
	});

	it("retires the unreturned observer when Restart fails", async () => {
		const fixture = outputFixture();
		fixture.observer.dispose();
		await expect(
			restartDesktopCodexWithResumeObservation(fixture.page as unknown as Page, "task", async () => {
				throw new Error("restart failed");
			}),
		).rejects.toThrow("restart failed");
		expect(fixture.page.listenerCount("websocket")).toBe(0);
	});
});

describe("actual TSX serialized resume document nonce", () => {
	it("executes in a fresh renderer realm with no module helpers and refuses changed documents", async () => {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				"import {readDesktopCodexResumeDocument} from './scripts/agent-lab/desktop-real-scenario.ts'; process.stdout.write(readDesktopCodexResumeDocument.toString());",
			],
			{ cwd: process.cwd(), timeout: 10_000 },
		);
		expect(stdout).not.toContain("__name");
		const nonce = "44444444-4444-4444-8444-444444444444";
		const realm = { crypto: { randomUUID: () => nonce } };
		const callback = runInNewContext(`(${stdout})`, realm) as typeof readDesktopCodexResumeDocument;
		expect(callback(null)).toBe(nonce);
		expect(callback(nonce)).toBe(nonce);
		expect(() => callback("changed")).toThrow("document changed");
		const reloaded = runInNewContext(`(${stdout})`, {
			crypto: realm.crypto,
		}) as typeof readDesktopCodexResumeDocument;
		expect(() => reloaded(nonce)).toThrow("document changed");
	}, 15_000);
});
