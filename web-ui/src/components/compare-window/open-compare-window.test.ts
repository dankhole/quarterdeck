import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceCompareWindowReady, type CompareWindowTarget, openCompareWindow } from "./open-compare-window";

const target: CompareWindowTarget = {
	projectId: "p1",
	taskId: "task-1",
	taskCreatedAt: 123,
	sourceRef: "feature",
	targetRef: "main",
	includeUncommitted: true,
	threeDotDiff: false,
	selectedPath: "src/file.ts",
};

class TestChannel {
	static channels: TestChannel[] = [];
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	closed = false;
	constructor(readonly name: string) {
		TestChannel.channels.push(this);
	}
	postMessage(value: unknown): void {
		for (const channel of TestChannel.channels) {
			if (channel !== this && !channel.closed && channel.name === this.name)
				channel.onmessage?.({ data: value } as MessageEvent<unknown>);
		}
	}
	close(): void {
		this.closed = true;
	}
}

describe("openCompareWindow", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		TestChannel.channels = [];
		vi.stubGlobal("BroadcastChannel", TestChannel);
		vi.spyOn(window, "open").mockReturnValue(null);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("opens synchronously with noopener and accepts a successful null return after startup", async () => {
		const pending = openCompareWindow(target);
		expect(window.open).toHaveBeenCalledOnce();
		const [href, name, features] = vi.mocked(window.open).mock.calls[0] ?? [];
		expect(name).toBe("_blank");
		expect(features).toBe("popup,width=1280,height=900,noopener");
		expect(new URL(String(href)).searchParams.get("taskCreatedAt")).toBe("123");
		announceCompareWindowReady(target);
		await expect(pending).resolves.toBeUndefined();
		expect(TestChannel.channels.every((channel) => channel.closed)).toBe(true);
	});

	it("reports a blocked popup and disposes the handshake", async () => {
		const pending = openCompareWindow(target);
		const rejected = expect(pending).rejects.toThrow("Allow popups");
		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
		expect(TestChannel.channels.every((channel) => channel.closed)).toBe(true);
	});

	it("does not accept startup from a different captured identity", async () => {
		const pending = openCompareWindow(target);
		const rejected = expect(pending).rejects.toThrow("Allow popups");
		announceCompareWindowReady({ ...target, projectId: "p2" });
		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
	});

	it("uses the typed desktop bridge without opening a browser window", async () => {
		const open = vi.fn().mockResolvedValue({ kind: "opened" });
		vi.stubGlobal("quarterdeckDesktop", {});
		vi.stubGlobal("quarterdeckDesktopCompare", { version: 1, openCompareWindow: open });
		await openCompareWindow(target);
		expect(open).toHaveBeenCalledWith(target);
		expect(window.open).not.toHaveBeenCalled();
		expect(TestChannel.channels).toHaveLength(0);
	});

	it("rejects missing or incompatible Compare bridges without falling back to browser opening", async () => {
		vi.stubGlobal("quarterdeckDesktop", {});
		await expect(openCompareWindow(target)).rejects.toThrow("Update Quarterdeck");
		vi.stubGlobal("quarterdeckDesktopCompare", { version: 2, openCompareWindow: vi.fn() });
		await expect(openCompareWindow(target)).rejects.toThrow("Update Quarterdeck");
		expect(window.open).not.toHaveBeenCalled();
	});

	it("requires an explicit desktop capability for Uncommitted but still accepts old Compare bridges", async () => {
		const workingCopy: CompareWindowTarget = {
			...target,
			reviewMode: "uncommitted",
			sourceRef: "HEAD",
			targetRef: "HEAD",
			includeUncommitted: true,
			threeDotDiff: false,
		};
		const open = vi.fn().mockResolvedValue({ kind: "opened" });
		vi.stubGlobal("quarterdeckDesktop", {});
		vi.stubGlobal("quarterdeckDesktopCompare", { version: 1, openCompareWindow: open });
		await expect(openCompareWindow(workingCopy)).rejects.toThrow("Update Quarterdeck");
		expect(open).not.toHaveBeenCalled();
		await openCompareWindow(target);
		expect(open).toHaveBeenCalledWith(target);
		vi.stubGlobal("quarterdeckDesktopCompare", {
			version: 1,
			supportsUncommittedReview: true,
			openCompareWindow: open,
		});
		await openCompareWindow(workingCopy);
		expect(open).toHaveBeenLastCalledWith(workingCopy);
		expect(window.open).not.toHaveBeenCalled();
	});

	it("round trips explicit browser working-copy mode through the startup handshake", async () => {
		const workingCopy: CompareWindowTarget = {
			...target,
			reviewMode: "uncommitted",
			sourceRef: "HEAD",
			targetRef: "HEAD",
			includeUncommitted: true,
			threeDotDiff: false,
		};
		const pending = openCompareWindow(workingCopy);
		expect(new URL(String(vi.mocked(window.open).mock.calls[0]?.[0])).searchParams.get("reviewMode")).toBe(
			"uncommitted",
		);
		announceCompareWindowReady(workingCopy);
		await expect(pending).resolves.toBeUndefined();
	});

	it("reports an unavailable desktop open", async () => {
		vi.stubGlobal("quarterdeckDesktop", {});
		vi.stubGlobal("quarterdeckDesktopCompare", {
			version: 1,
			openCompareWindow: vi.fn().mockResolvedValue({ kind: "unavailable" }),
		});
		await expect(openCompareWindow(target)).rejects.toThrow("Could not open");
		expect(window.open).not.toHaveBeenCalled();
	});
});
