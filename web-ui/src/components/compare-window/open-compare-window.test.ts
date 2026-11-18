import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CompareWindowTarget, openCompareWindow } from "./open-compare-window";

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

describe("openCompareWindow", () => {
	beforeEach(() => {
		vi.spyOn(window, "open").mockReturnValue(null);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("uses the typed desktop bridge without opening a browser window", async () => {
		const open = vi.fn().mockResolvedValue({ kind: "opened" });
		vi.stubGlobal("quarterdeckDesktopCompare", { version: 1, openCompareWindow: open });
		await openCompareWindow(target);
		expect(open).toHaveBeenCalledWith(target);
		expect(window.open).not.toHaveBeenCalled();
	});

	it("rejects missing or incompatible Compare bridges without a browser fallback", async () => {
		vi.stubGlobal("quarterdeckDesktopCompare", undefined);
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

	it("reports an unavailable desktop open", async () => {
		vi.stubGlobal("quarterdeckDesktopCompare", {
			version: 1,
			openCompareWindow: vi.fn().mockResolvedValue({ kind: "unavailable" }),
		});
		await expect(openCompareWindow(target)).rejects.toThrow("Could not open");
		expect(window.open).not.toHaveBeenCalled();
	});
});
