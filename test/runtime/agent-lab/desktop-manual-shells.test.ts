import type { Locator, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
	assertDesktopManualShellFresh,
	assertDesktopManualShellPreserved,
	type DesktopManualShellSnapshot,
	requireDesktopManualShell,
	waitForDesktopManualShellRetirement,
} from "../../../scripts/agent-lab/desktop-manual-shell-evidence";
import {
	validateDesktopManualShellSelection,
	waitForDesktopManualShellDetailSelection,
} from "../../../scripts/agent-lab/desktop-manual-shells";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api/task-session";

function live(): DesktopManualShellSnapshot {
	return {
		session: runtimeTaskSessionSummarySchema.parse({
			taskId: "__home_terminal__",
			sessionInstanceId: "shell-one",
			state: "running",
			agentId: null,
			sessionLaunchPath: "/synthetic/project",
			pid: 50002,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
		}),
		process: { pid: 50002, parentPid: 50001, startedAt: "original birth", command: "/bin/zsh -i" },
		dedicatedSlotIds: [1],
		helperTextareas: 1,
		parkedTextareas: 0,
	};
}
function retired(): DesktopManualShellSnapshot {
	return { session: null, process: null, dedicatedSlotIds: [], helperTextareas: 0, parkedTextareas: 0 };
}
function observation(capture: () => Promise<DesktopManualShellSnapshot>) {
	let now = 0;
	return {
		capture,
		now: () => now,
		wait: vi.fn(async (ms: number) => {
			now += ms;
		}),
	};
}

describe("packaged manual shell acceptance evidence", () => {
	it("does not admit the generic Home Open terminal while Detail selection is still hydrating", async () => {
		let revealDetail: () => void = () => {
			throw new Error("Missing hydration completion.");
		};
		const detailHydrated = new Promise<void>((resolve) => {
			revealDetail = resolve;
		});
		const homeOpenVisible = vi.fn(async () => {});
		const titleVisible = vi.fn(async () => {});
		const toolbar = {
			getByRole: vi.fn((_role: string, options: { name: string }) => ({
				waitFor: options.name === "Back to board" ? () => detailHydrated : homeOpenVisible,
			})),
			getByText: vi.fn(() => ({ waitFor: titleVisible })),
		};
		const page = { locator: vi.fn(() => toolbar as unknown as Locator) } satisfies Pick<Page, "locator">;
		const readSelectedTaskTitle = vi.fn(async () => "Exact synthetic task");
		let admitted = false;
		const selection = waitForDesktopManualShellDetailSelection(page, readSelectedTaskTitle).then(() => {
			admitted = true;
		});
		await Promise.resolve();
		expect(admitted).toBe(false);
		expect(readSelectedTaskTitle).not.toHaveBeenCalled();
		revealDetail();
		await selection;
		expect(admitted).toBe(true);
		expect(toolbar.getByText).toHaveBeenCalledExactlyOnceWith("Exact synthetic task", { exact: true });
		expect(homeOpenVisible).not.toHaveBeenCalled();
	});
	it("fails closed when the bounded task-specific Detail hydration gate times out", async () => {
		const waitFor = vi.fn(async () => {
			throw new Error("Detail hydration timed out");
		});
		const toolbar = { getByRole: () => ({ waitFor }) };
		const page = { locator: () => toolbar as unknown as Locator } satisfies Pick<Page, "locator">;
		const readSelectedTaskTitle = vi.fn(async () => "Exact synthetic task");
		await expect(waitForDesktopManualShellDetailSelection(page, readSelectedTaskTitle)).rejects.toThrow(
			"Detail hydration timed out",
		);
		expect(waitFor).toHaveBeenCalledExactlyOnceWith({ state: "visible", timeout: 15_000 });
		expect(readSelectedTaskTitle).not.toHaveBeenCalled();
	});
	it("keeps exact shell, session and slot identity across hidden native close", () => {
		expect(() => assertDesktopManualShellPreserved(requireDesktopManualShell(live()), live())).not.toThrow();
	});
	it.each(["session", "birth", "argv", "slot"])("rejects same-PID %s replacement after hidden close", (change) => {
		const before = requireDesktopManualShell(live());
		const after = live();
		if (change === "session" && after.session) after.session.sessionInstanceId = "replaced-session";
		if (change === "birth" && after.process) after.process.startedAt = "reused-pid";
		if (change === "argv" && after.process) after.process.command = "/bin/unrelated";
		if (change === "slot") after.dedicatedSlotIds = [2];
		expect(() => assertDesktopManualShellPreserved(before, after)).toThrow("replaced the exact manual shell");
	});
	it("requires new process, session and dedicated slot when reopening", () => {
		const before = requireDesktopManualShell(live());
		expect(() => assertDesktopManualShellFresh(before, before)).toThrow("fresh PTY");
		const next = live();
		if (next.session && next.process) {
			next.session.pid = next.process.pid = 50003;
			next.session.sessionInstanceId = "shell-two";
			next.session.startedAt = 2;
			next.process.startedAt = "new birth";
		}
		next.dedicatedSlotIds = [2];
		expect(() => assertDesktopManualShellFresh(before, requireDesktopManualShell(next))).not.toThrow();
	});
	it("waits for process exit, slot disposal and the entire quiet interval", async () => {
		const capture = vi.fn().mockResolvedValueOnce(live()).mockResolvedValue(retired());
		const ports = observation(capture);
		await expect(
			waitForDesktopManualShellRetirement(requireDesktopManualShell(live()), ports, {
				timeoutMs: 100,
				quietMs: 20,
				pollMs: 10,
			}),
		).resolves.toEqual(retired());
		expect(capture).toHaveBeenCalledTimes(4);
		expect(ports.now()).toBe(30);
	});
	it("does not accept a cleared runtime PID while the exact shell process lives", async () => {
		const processStillLive = { ...retired(), process: live().process };
		const ports = observation(async () => processStillLive);
		await expect(
			waitForDesktopManualShellRetirement(requireDesktopManualShell(live()), ports, {
				timeoutMs: 20,
				quietMs: 5,
				pollMs: 5,
			}),
		).rejects.toThrow("panel close timed out");
		expect(ports.now()).toBe(20);
	});
	it("fails boundedly when close leaves a parked dedicated terminal", async () => {
		const ports = observation(async () => ({ ...retired(), dedicatedSlotIds: [1], parkedTextareas: 1 }));
		await expect(
			waitForDesktopManualShellRetirement(requireDesktopManualShell(live()), ports, {
				timeoutMs: 20,
				quietMs: 5,
				pollMs: 5,
			}),
		).rejects.toThrow("terminal disposal");
		expect(ports.wait).toHaveBeenCalledTimes(4);
	});
	it("fails if a new exact session silently restarts during the post-close interval", async () => {
		const restarted = live();
		if (restarted.session) restarted.session.sessionInstanceId = "automatic-replacement";
		const capture = vi.fn().mockResolvedValueOnce(retired()).mockResolvedValue(restarted);
		await expect(
			waitForDesktopManualShellRetirement(requireDesktopManualShell(live()), observation(capture), {
				timeoutMs: 100,
				quietMs: 20,
				pollMs: 10,
			}),
		).rejects.toThrow("replaced or restarted");
	});
	it("fails closed when process observation is unavailable", async () => {
		const ports = observation(async () => {
			throw new Error("process census unavailable");
		});
		await expect(waitForDesktopManualShellRetirement(requireDesktopManualShell(live()), ports)).rejects.toThrow(
			"process census unavailable",
		);
		expect(ports.wait).not.toHaveBeenCalled();
	});
	it.each([
		{},
		{ includeAgent: true },
		{ includeAgent: false, showWindow: true },
		{ includeAgent: false, agentMode: "real-codex" },
		{ includeAgent: false, npmLaunch: true },
		{ includeAgent: false, performance: true },
		{ includeAgent: false, nativeExperience: true },
		{ includeAgent: false, mainLoss: true },
	])("rejects conflicting scenario options before fixture/account access: %j", (options) => {
		expect(() => validateDesktopManualShellSelection(options)).toThrow("no other scenario");
	});
	it("permits only the fake hidden no-agent scenario", () => {
		expect(() => validateDesktopManualShellSelection({ includeAgent: false })).not.toThrow();
	});
});
