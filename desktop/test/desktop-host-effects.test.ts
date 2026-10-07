import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHostEffectDispatcher, type DesktopHostEffectIdentity } from "../src/desktop-host-effects.js";

vi.mock("electron", () => ({
	dialog: { showOpenDialog: vi.fn() },
	shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));
afterEach(() => vi.useRealTimers());

function fixture() {
	const sender = {};
	const identity: DesktopHostEffectIdentity = {
		sender,
		startupId: randomUUID(),
		runtimeGeneration: randomUUID(),
		ownership: "owned",
		synthetic: false,
		stopping: false,
	};
	const parent = {
		isDestroyed: vi.fn(() => false),
		isMinimized: vi.fn(() => true),
		restore: vi.fn(),
		show: vi.fn(),
		focus: vi.fn(),
	};
	const services = {
		showDirectoryDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
		openExternalUrl: vi.fn(async () => {}),
		openPath: vi.fn(async () => ""),
		openProject: vi.fn(async () => true),
	};
	const dispatcher = new DesktopHostEffectDispatcher({
		getIdentity: () => identity,
		getParentWindow: () => parent as unknown as BrowserWindow,
		services,
		deadlineMs: 25,
		maxPending: 1,
	});
	const message = (sequence = 1, action: Record<string, unknown> = { method: "pick-directory" }) => ({
		type: "quarterdeck:desktop-host-request",
		protocolVersion: 1,
		startupId: identity.startupId,
		runtimeGeneration: identity.runtimeGeneration,
		requestId: randomUUID(),
		sequence,
		action,
	});
	return { identity, parent, services, sender, dispatcher, message };
}

describe("native host effects on the private parent channel", () => {
	it("parents and focuses the folder picker and returns cancellation without a path", async () => {
		const f = fixture();
		expect((await f.dispatcher.handleMessage(f.message(), f.sender))?.result).toEqual({ status: "cancelled" });
		expect(f.services.showDirectoryDialog).toHaveBeenCalledWith(f.parent);
		expect(f.parent.restore).toHaveBeenCalledOnce();
		expect(f.parent.show).toHaveBeenCalledOnce();
		expect(f.parent.focus).toHaveBeenCalledTimes(2);
	});
	it.each(["attached", "synthetic", "stopping", "wrong-sender", "wrong-generation", "wrong-startup"])(
		"denies %s before any native effect",
		async (condition) => {
			const f = fixture();
			const request = f.message();
			if (condition === "attached") f.identity.ownership = "attached";
			if (condition === "synthetic") f.identity.synthetic = true;
			if (condition === "stopping") f.identity.stopping = true;
			if (condition === "wrong-generation") request.runtimeGeneration = randomUUID();
			if (condition === "wrong-startup") request.startupId = randomUUID();
			expect(
				(await f.dispatcher.handleMessage(request, condition === "wrong-sender" ? {} : f.sender))?.result,
			).toEqual({ status: "failed", reason: "denied" });
			expect(f.services.showDirectoryDialog).not.toHaveBeenCalled();
			expect(f.parent.show).not.toHaveBeenCalled();
		},
	);
	it("rejects renderer-style arbitrary commands, unsafe URL schemes and relative paths", async () => {
		const f = fixture();
		for (const action of [
			{ method: "open-project", targetId: "arbitrary-app", path: "/synthetic" },
			{ method: "open-project", targetId: "vscode", path: "/synthetic", executable: "sh", args: ["-c", "bad"] },
			{ method: "open-external-url", url: "file:///private" },
			{ method: "open-path", path: "../private" },
		]) {
			expect(await f.dispatcher.handleMessage(f.message(1, action), f.sender)).toBeNull();
		}
		expect(f.services.openProject).not.toHaveBeenCalled();
		expect(f.services.openExternalUrl).not.toHaveBeenCalled();
		expect(f.services.openPath).not.toHaveBeenCalled();
	});
	it("uses canonical allowlisted IDE arguments with spaces and Unicode intact", async () => {
		const f = fixture();
		expect(
			(
				await f.dispatcher.handleMessage(
					f.message(1, { method: "open-project", targetId: "vscode", path: "/synthetic/Project Ω" }),
					f.sender,
				)
			)?.result,
		).toEqual({ status: "opened" });
		expect(f.services.openProject).toHaveBeenCalledWith(
			["-a", "Visual Studio Code", "/synthetic/Project Ω"],
			"/synthetic/Project Ω",
		);
		expect((await f.dispatcher.handleMessage(f.message(1), f.sender))?.result).toEqual({
			status: "failed",
			reason: "denied",
		});
	});
	it("retains a timed-out native picker slot until the actual sheet closes", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let cancel = (_value: { canceled: boolean; filePaths: string[] }): void => {};
		f.services.showDirectoryDialog.mockImplementation(
			() =>
				new Promise((resolve) => {
					cancel = resolve;
				}),
		);
		const pending = f.dispatcher.handleMessage(f.message(), f.sender);
		await vi.advanceTimersByTimeAsync(25);
		expect((await pending)?.result).toEqual({ status: "failed", reason: "timeout" });
		expect((await f.dispatcher.handleMessage(f.message(2), f.sender))?.result).toEqual({
			status: "failed",
			reason: "busy",
		});
		cancel({ canceled: true, filePaths: [] });
		await Promise.resolve();
		await Promise.resolve();
		expect(f.services.showDirectoryDialog).toHaveBeenCalledOnce();
	});
	it("does not return selected paths after a runtime generation changes", async () => {
		const f = fixture();
		f.services.showDirectoryDialog.mockImplementation(async () => {
			f.identity.runtimeGeneration = randomUUID();
			return { canceled: false, filePaths: ["/synthetic/project"] };
		});
		expect((await f.dispatcher.handleMessage(f.message(), f.sender))?.result).toEqual({
			status: "failed",
			reason: "denied",
		});
		expect(f.parent.focus).toHaveBeenCalledTimes(1);
	});
});
