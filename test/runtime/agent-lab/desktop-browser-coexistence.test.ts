import { ChildProcess, execFile } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
	_testing,
	type DesktopBrowserClientEvidence,
	DesktopBrowserCoexistenceError,
	type DesktopBrowserCoexistencePorts,
} from "../../../scripts/agent-lab/desktop-browser-coexistence";
import {
	DesktopPerformanceScenarioError,
	type DesktopPerformanceScenarioEvidence,
} from "../../../scripts/agent-lab/desktop-performance-scenario";

const owner = {
	pid: 50001,
	creationIdentity: "synthetic-birth",
	generation: "synthetic-generation",
	origin: "http://127.0.0.1:45678",
};
const client: DesktopBrowserClientEvidence = {
	revision: 3,
	boardDigest: "synthetic-board",
	taskId: "task-1",
	columnId: "review",
	sessionInstanceId: "pty-1",
	providerSessionId: "provider-1",
	pid: 50002,
	state: "awaiting_review",
	viewportRows: 30,
};

function fixture() {
	let rows = 30;
	const ports = {
		readOwner: vi.fn().mockImplementation(async () => ({ ...owner })),
		readDesktop: vi.fn().mockImplementation(async () => ({ ...client, viewportRows: rows })),
		openBrowser: vi.fn().mockResolvedValue(undefined),
		readBrowser: vi.fn().mockImplementation(async () => ({ ...client, viewportRows: rows })),
		resize: vi.fn().mockImplementation(async (_width: number, height: number) => {
			rows = height === 720 ? 25 : 40;
		}),
		closeBrowser: vi.fn().mockResolvedValue(undefined),
	} satisfies DesktopBrowserCoexistencePorts;
	return ports;
}

function unavailablePerformance(): DesktopPerformanceScenarioEvidence {
	return {
		schemaVersion: 2,
		runId: "synthetic-performance",
		projectId: "project-1",
		taskId: client.taskId,
		conditions: { desktopVisible: false, browserHeadless: true },
		completed: false,
		idleNavigationCompleted: true,
		stableComparison: true,
		progressAvailability: { mode: "unavailable", reason: "production-terminal-content-disabled" },
		cohorts: [],
		navigation: {},
		progress: [],
		limitations: [],
	};
}

describe("optional coexistence performance measurement", () => {
	it("executes actual TSX navigation in the wrapper VM with the same inner timing and bounded safe failure phases", async () => {
		const moduleUrl = new URL("../../../scripts/agent-lab/desktop-browser-coexistence.ts", import.meta.url);
		const script = `
			import { _testing } from ${JSON.stringify(moduleUrl.href)};
			import vm from 'node:vm';
			const runs = [];
			for (const mode of ['same-task', 'wrong-before', 'wrong-after', 'back-failure', 'scope-timeout', 'clock-reset', 'clock-backwards', 'clock-invalid', 'viewport-change']) {
				const calls = [];
				const gates = [];
				let now = 0, clockReads = 0, disposedClocks = 0;
				let url = 'http://127.0.0.1:45678/project-1?task=' + (mode === 'wrong-before' ? 'other-task' : 'task-1');
				const page = {
					url() { return url; },
					async waitForURL(predicate, bounds) {
						gates.push(bounds);
						now += 1000;
						if(mode === 'scope-timeout') throw new Error('private SDK timeout');
						if(!predicate(new URL(url))) throw new Error('SDK gate must reject a wrong current URL synchronously');
					},
					getByRole(role, options) {
						return {
							async click(bounds) { calls.push({kind:'back', role, name:options.name, bounds}); now += 5; if(mode === 'back-failure') throw new Error('private browser failure'); url = 'http://127.0.0.1:45678/project-1'; },
							async waitFor(bounds) { calls.push({kind:'terminal', role, name:options.name, bounds}); now += 8; }
						};
					},
					locator(selector) {
						return {
							first() { return this; },
							async waitFor(bounds) { calls.push({kind:'board', selector, bounds}); now += 10; },
							async click(bounds) { calls.push({kind:'task', selector, bounds}); now += 7; url += '?task=' + (mode === 'wrong-after' ? 'other-task' : 'task-1'); }
						};
					},
					async waitForFunction(callback, argument, bounds) {
						if(argument !== undefined || bounds.timeout !== 5000) throw new Error('Unbounded clock read');
						clockReads++;
						const renderer = vm.createContext({performance:{now:() => mode === 'clock-invalid' ? NaN : mode === 'clock-backwards' && clockReads === 2 ? 0 : now,timeOrigin:mode === 'clock-reset' && clockReads === 2 ? 2 : 1},innerWidth:1460,innerHeight:mode === 'viewport-change' && clockReads === 2 ? 1040 : 1012});
						const value = vm.runInContext('(' + callback.toString() + ')()',renderer);
						return {async jsonValue(){return value;},async dispose(){disposedClocks++;}};
					}
				};
				const context = vm.createContext({page,__end__:{}});
				if(vm.runInContext('typeof URL + ":" + typeof URLSearchParams + ":" + typeof performance', context) !== 'undefined:undefined:undefined') throw new Error('Wrapper VM unexpectedly has browser globals');
				const navigate = vm.runInContext('(' + _testing.performanceNavigationScript({projectId:'project-1',taskId:'task-1'}) + ')', context);
				const result = await navigate(page);
				runs.push(JSON.parse(JSON.stringify({mode,calls,gates,result})));
				if(clockReads !== disposedClocks)throw new Error('Navigation leaked clock handles');
				if(mode === 'same-task') {
					url = 'http://127.0.0.1:45678/project-1?task=task-1';
					clockReads = 0;
					const direct = await _testing.navigatePerformanceTask(page,{projectId:'project-1',taskId:'task-1'});
					if(JSON.stringify(direct) !== JSON.stringify(result.timing))throw new Error('Direct and wrapper boundaries differ');
				}
			}
			process.stdout.write(JSON.stringify(runs));
		`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script],
			{
				cwd: fileURLToPath(new URL("../../../", import.meta.url)),
				timeout: 10_000,
				maxBuffer: 32 * 1024,
			},
		);
		const result: unknown = JSON.parse(stdout);
		expect(result).toEqual([
			{
				mode: "same-task",
				result: {
					outcome: "acknowledged",
					timing: {
						boundary: "ui-action-to-terminal-visible",
						clock: "renderer-monotonic",
						durationMs: 30,
						viewport: { width: 1460, height: 1012 },
					},
				},
				gates: [
					{ timeout: 5_000, waitUntil: "commit" },
					{ timeout: 5_000, waitUntil: "commit" },
				],
				calls: [
					{ kind: "back", role: "button", name: "Back to board", bounds: { timeout: 5_000 } },
					{ kind: "board", selector: "section.kb-board", bounds: { state: "visible", timeout: 5_000 } },
					{ kind: "task", selector: '[data-task-id="task-1"]', bounds: { timeout: 5_000 } },
					{
						kind: "terminal",
						role: "textbox",
						name: "Terminal input",
						bounds: { state: "visible", timeout: 5_000 },
					},
				],
			},
			{
				mode: "wrong-before",
				calls: [],
				gates: [{ timeout: 5_000, waitUntil: "commit" }],
				result: { outcome: "failed", phase: "scope_before" },
			},
			{
				mode: "wrong-after",
				calls: expect.any(Array),
				gates: [
					{ timeout: 5_000, waitUntil: "commit" },
					{ timeout: 5_000, waitUntil: "commit" },
				],
				result: { outcome: "failed", phase: "scope_after" },
			},
			{
				mode: "back-failure",
				calls: [{ kind: "back", role: "button", name: "Back to board", bounds: { timeout: 5_000 } }],
				gates: [{ timeout: 5_000, waitUntil: "commit" }],
				result: { outcome: "failed", phase: "back_to_board" },
			},
			{
				mode: "scope-timeout",
				calls: [],
				gates: [{ timeout: 5_000, waitUntil: "commit" }],
				result: { outcome: "failed", phase: "scope_before" },
			},
			...["clock-reset", "clock-backwards"].map((mode) => ({
				mode,
				calls: expect.any(Array),
				gates: [{ timeout: 5000, waitUntil: "commit" }],
				result: { outcome: "failed", phase: "clock_after" },
			})),
			{
				mode: "clock-invalid",
				calls: [],
				gates: [{ timeout: 5000, waitUntil: "commit" }],
				result: { outcome: "failed", phase: "clock_before" },
			},
			{
				mode: "viewport-change",
				calls: expect.any(Array),
				gates: [{ timeout: 5000, waitUntil: "commit" }],
				result: { outcome: "failed", phase: "clock_after" },
			},
		]);
	}, 15_000);

	it("admits only acknowledged navigation or a fixed safe browser-action phase", () => {
		const timing = {
			boundary: "ui-action-to-terminal-visible",
			clock: "renderer-monotonic",
			durationMs: 30,
			viewport: { width: 1460, height: 1012 },
		};
		expect(_testing.readPerformanceNavigationResult({ outcome: "acknowledged", timing })).toEqual({
			phase: null,
			timing,
		});
		expect(_testing.readPerformanceNavigationResult({ outcome: "failed", phase: "select_task" })).toEqual({
			phase: "select_task",
			timing: null,
		});
		for (const raw of ["private browser output", { phase: "private browser output" }, null, undefined])
			expect(_testing.readPerformanceNavigationResult(raw)).toEqual({ phase: "unknown", timing: null });
		expect(
			_testing.readPerformanceNavigationResult({
				outcome: "acknowledged",
				timing: { ...timing, durationMs: Infinity },
			}),
		).toEqual({ phase: "unknown", timing: null });
	});

	it("preserves explicitly incomplete measurement evidence after functional proof and before browser close", async () => {
		const evidence = unavailablePerformance();
		const ports = { ...fixture(), measurePerformance: vi.fn().mockResolvedValue(evidence) };
		const proof = await _testing.proveCoexistence("synthetic-browser", ports);
		expect(proof.performance).toBe(evidence);
		expect(proof.performance?.completed).toBe(false);
		expect(proof.cleanupConfirmed).toBe(true);
		const measuredAt = ports.measurePerformance.mock.invocationCallOrder[0] ?? 0;
		expect(measuredAt).toBeGreaterThan(ports.resize.mock.invocationCallOrder.at(-1) ?? 0);
		for (const read of [ports.readOwner, ports.readDesktop, ports.readBrowser]) {
			expect(read.mock.invocationCallOrder.some((order) => order < measuredAt)).toBe(true);
			expect(read.mock.invocationCallOrder.some((order) => order > measuredAt)).toBe(true);
		}
		expect(ports.closeBrowser.mock.invocationCallOrder[0]).toBeGreaterThan(measuredAt);
		expect(ports.readDesktop.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
			ports.closeBrowser.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("does not measure when the original functional viewport proof fails", async () => {
		const ports = { ...fixture(), measurePerformance: vi.fn().mockResolvedValue(unavailablePerformance()) };
		ports.resize.mockResolvedValue(undefined);
		await expect(_testing.proveCoexistence("synthetic-browser", ports)).rejects.toMatchObject({
			failureStage: "viewport_check",
			cleanupConfirmed: true,
		});
		expect(ports.measurePerformance).not.toHaveBeenCalled();
		expect(ports.closeBrowser).toHaveBeenCalledOnce();
	});

	it.each(["board", "session", "owner"] as const)(
		"rejects %s changes during measurement using the original baseline",
		async (changed) => {
			const ports = {
				...fixture(),
				measurePerformance: vi.fn(async () => {
					if (changed === "board")
						ports.readDesktop.mockResolvedValue({ ...client, revision: client.revision + 1 });
					if (changed === "session")
						ports.readBrowser.mockResolvedValue({ ...client, sessionInstanceId: "new-pty" });
					if (changed === "owner") ports.readOwner.mockResolvedValue({ ...owner, generation: "new-generation" });
					return unavailablePerformance();
				}),
			};
			await expect(_testing.proveCoexistence("synthetic-browser", ports)).rejects.toMatchObject({
				failureStage: "performance_check",
				cleanupConfirmed: true,
				owner,
			});
			expect(ports.closeBrowser).toHaveBeenCalledOnce();
		},
	);

	it("retains a measurement failure stage and exact browser cleanup without exposing private errors", async () => {
		const ports = {
			...fixture(),
			measurePerformance: vi.fn().mockRejectedValue(new Error("private measurement error")),
		};
		const error: unknown = await _testing
			.proveCoexistence("synthetic-browser", ports)
			.catch((error: unknown) => error);
		expect(error).toMatchObject({ failureStage: "performance", cleanupConfirmed: true });
		expect(JSON.stringify(error)).not.toContain("private measurement error");
		expect(ports.closeBrowser).toHaveBeenCalledOnce();
	});

	it("preserves incomplete idle/navigation evidence rather than dropping it as unsuccessful", async () => {
		const evidence = unavailablePerformance();
		const write = vi.fn().mockResolvedValue(undefined);
		await expect(_testing.recordPerformanceEvidence(async () => evidence, write)).resolves.toBe(evidence);
		expect(write).toHaveBeenCalledExactlyOnceWith(evidence);
	});

	it("writes typed partial evidence before propagating a measurement failure", async () => {
		const evidence = { ...unavailablePerformance(), idleNavigationCompleted: false, stableComparison: false };
		const failure = new DesktopPerformanceScenarioError("navigation", evidence);
		const write = vi.fn().mockResolvedValue(undefined);
		await expect(
			_testing.recordPerformanceEvidence(async () => {
				throw failure;
			}, write),
		).rejects.toBe(failure);
		expect(write).toHaveBeenCalledExactlyOnceWith(evidence);
	});

	it("does not serialize arbitrary failed callback output as performance evidence", async () => {
		const failure = new Error("private command output");
		const write = vi.fn().mockResolvedValue(undefined);
		await expect(
			_testing.recordPerformanceEvidence(async () => {
				throw failure;
			}, write),
		).rejects.toBe(failure);
		expect(write).not.toHaveBeenCalled();
	});
});

describe("desktop and ordinary browser coexistence proof", () => {
	it("admits one existing task in both clients across two resizes and confirms cleanup", async () => {
		const ports = fixture();
		const proof = await _testing.proveCoexistence("synthetic-browser", ports);
		expect(proof.owner).toEqual(owner);
		expect(proof.cleanupConfirmed).toBe(true);
		expect(proof.checkpoints.map((point) => point.browser.viewportRows)).toEqual([25, 40]);
		expect(ports.openBrowser).toHaveBeenCalledTimes(1);
		expect(ports.resize).toHaveBeenCalledTimes(2);
		expect(ports.closeBrowser).toHaveBeenCalledTimes(1);
		expect(ports.readOwner.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
			ports.closeBrowser.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("attempts wrapper cleanup even when open or private browser admission fails", async () => {
		const ports = fixture();
		ports.openBrowser.mockRejectedValue(new Error("private bootstrap details"));
		await expect(_testing.proveCoexistence("synthetic-browser", ports)).rejects.toMatchObject({
			code: "DesktopBrowserCoexistenceFailed",
			owner,
			cleanupConfirmed: true,
			failureStage: "open_browser",
		});
		expect(ports.closeBrowser).toHaveBeenCalledTimes(1);
		expect(ports.resize).not.toHaveBeenCalled();
	});

	it.each(["sessionInstanceId", "providerSessionId", "pid", "boardDigest", "revision", "taskId"] as const)(
		"rejects changed %s rather than passing a second task/session as coexistence",
		async (key) => {
			const ports = fixture();
			ports.readBrowser.mockResolvedValue({
				...client,
				[key]: typeof client[key] === "number" ? 999 : "replacement",
			});
			const proof = _testing.proveCoexistence("synthetic-browser", ports);
			await expect(proof).rejects.toBeInstanceOf(DesktopBrowserCoexistenceError);
			await expect(proof).rejects.toMatchObject({
				failureStage: "read_browser",
			});
			expect(ports.closeBrowser).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["generation", "creationIdentity"] as const)(
		"rejects changed owner %s with retained original ownership evidence",
		async (key) => {
			const ports = fixture();
			ports.readOwner.mockResolvedValueOnce({ ...owner }).mockResolvedValue({ ...owner, [key]: "replacement" });
			await expect(_testing.proveCoexistence("synthetic-browser", ports)).rejects.toMatchObject({
				owner,
				cleanupConfirmed: true,
				failureStage: "owner_check",
			});
			expect(ports.closeBrowser).toHaveBeenCalledTimes(1);
		},
	);

	it("does not claim clean browser shutdown when exact session cleanup fails", async () => {
		const ports = fixture();
		ports.closeBrowser.mockRejectedValue(new Error("private failure details"));
		await expect(_testing.proveCoexistence("synthetic-browser", ports)).rejects.toMatchObject({
			browserSession: "synthetic-browser",
			owner,
			cleanupConfirmed: false,
			failureStage: "close_browser",
			message: "Desktop/browser coexistence browser cleanup is unconfirmed; retain the synthetic fixture.",
		});
	});

	it("requires real viewport change in both clients", async () => {
		const ports = fixture();
		ports.resize.mockResolvedValue(undefined);
		await expect(_testing.proveCoexistence("synthetic-browser", ports)).rejects.toMatchObject({
			cleanupConfirmed: true,
			failureStage: "viewport_check",
		});
		expect(ports.closeBrowser).toHaveBeenCalledTimes(1);
	});

	it.each(["readDesktop", "readBrowser", "resize"] as const)(
		"retains only a stable failure stage when %s rejects",
		async (operation) => {
			const ports = fixture();
			const expectedStage = { readDesktop: "read_desktop", readBrowser: "read_browser", resize: "resize" };
			ports[operation].mockRejectedValue(new Error("private credential-bearing output"));
			const error: unknown = await _testing
				.proveCoexistence("synthetic-browser", ports)
				.catch((value: unknown) => value);
			expect(error).toMatchObject({ owner, cleanupConfirmed: true, failureStage: expectedStage[operation] });
			expect(JSON.stringify(error)).not.toContain("private credential-bearing output");
			expect(ports.closeBrowser).toHaveBeenCalledTimes(operation === "readDesktop" ? 0 : 1);
		},
	);

	it("preserves the primary failure stage when cleanup also fails", async () => {
		const ports = fixture();
		ports.openBrowser.mockRejectedValue(new Error("private open failure"));
		ports.closeBrowser.mockRejectedValue(new Error("private close failure"));
		await expect(_testing.proveCoexistence("synthetic-browser", ports)).rejects.toMatchObject({
			failureStage: "open_browser",
			cleanupConfirmed: false,
		});
	});

	it("identifies owner replacement after a confirmed browser close as a final-check failure", async () => {
		const ports = fixture();
		ports.readOwner
			.mockResolvedValueOnce({ ...owner })
			.mockResolvedValueOnce({ ...owner })
			.mockResolvedValueOnce({ ...owner })
			.mockResolvedValue({ ...owner, generation: "replacement" });
		await expect(_testing.proveCoexistence("synthetic-browser", ports)).rejects.toMatchObject({
			owner,
			failureStage: "final_check",
			cleanupConfirmed: true,
		});
		expect(ports.closeBrowser).toHaveBeenCalledTimes(1);
	});

	it("extracts only the bounded wrapper Result section, refusing missing or oversized evidence", () => {
		expect(
			_testing.parseWrapperResult('### Result\n{"state":"synthetic"}\n### Ran Playwright code\nignored'),
		).toEqual({ state: "synthetic" });
		expect(() => _testing.parseWrapperResult("unstructured private output")).toThrow("bounded coexistence result");
		expect(() => _testing.parseWrapperResult(`### Result\n${JSON.stringify("x".repeat(256 * 1024))}`)).toThrow(
			"bounded coexistence result",
		);
	});
});

describe("bounded coexistence wrapper commands", () => {
	function wrapper() {
		const child = new ChildProcess();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		return { child, kill: vi.spyOn(child, "kill"), unref: vi.spyOn(child, "unref") };
	}

	it("returns bounded output only after a successful wrapper close event", async () => {
		const { child, kill } = wrapper();
		const result = _testing.runBoundedBrowserCommand(() => child);
		child.stdout?.emit("data", Buffer.from("synthetic result"));
		child.emit("close", 0, null);
		await expect(result).resolves.toBe("synthetic result");
		expect(kill).not.toHaveBeenCalled();
	});

	it("times out without signalling the wrapper and retains cleanup uncertainty", async () => {
		vi.useFakeTimers();
		const { child, kill, unref } = wrapper();
		try {
			const result = _testing.runBoundedBrowserCommand(() => child, 20);
			const rejected = expect(result).rejects.toThrow("unconfirmed");
			await vi.advanceTimersByTimeAsync(20);
			await rejected;
			child.emit("close", 0, null);
			expect(kill).not.toHaveBeenCalled();
			expect(unref).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds combined stdout/stderr without automatic process termination or private output exposure", async () => {
		const { child, kill, unref } = wrapper();
		const result = _testing.runBoundedBrowserCommand(() => child, 1_000, 20);
		child.stdout?.emit("data", Buffer.from("private stdout"));
		child.stderr?.emit("data", Buffer.from("private stderr"));
		await expect(result).rejects.toThrow("unconfirmed");
		expect(kill).not.toHaveBeenCalled();
		expect(unref).toHaveBeenCalledTimes(1);
	});
});
