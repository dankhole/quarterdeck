import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTaskStartGeometry } from "@/hooks/board/task-session-geometry";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getTerminalGeometry, prepareWaitForTerminalGeometry } from "@/terminal/terminal-geometry-registry";

vi.mock("@/terminal/terminal-geometry-registry", () => ({
	getTerminalGeometry: vi.fn(),
	prepareWaitForTerminalGeometry: vi.fn(),
}));

vi.mock("@/runtime/task-session-geometry", () => ({
	estimateTaskSessionGeometry: vi.fn(),
}));

const getTerminalGeometryMock = vi.mocked(getTerminalGeometry);
const prepareWaitForTerminalGeometryMock = vi.mocked(prepareWaitForTerminalGeometry);
const estimateTaskSessionGeometryMock = vi.mocked(estimateTaskSessionGeometry);

describe("resolveTaskStartGeometry", () => {
	beforeEach(() => {
		getTerminalGeometryMock.mockReset();
		prepareWaitForTerminalGeometryMock.mockReset();
		estimateTaskSessionGeometryMock.mockReset();
		prepareWaitForTerminalGeometryMock.mockReturnValue(async () => {});
		estimateTaskSessionGeometryMock.mockReturnValue({ cols: 120, rows: 40 });
	});

	it("briefly waits for already reported terminal geometry to settle", async () => {
		getTerminalGeometryMock.mockReturnValueOnce({ cols: 80, rows: 30 }).mockReturnValueOnce({ cols: 150, rows: 44 });

		await expect(
			resolveTaskStartGeometry({
				taskId: "task-1",
				viewportWidth: 1440,
				viewportHeight: 900,
			}),
		).resolves.toEqual({ cols: 150, rows: 44 });

		expect(prepareWaitForTerminalGeometryMock).toHaveBeenCalledWith("task-1", 100);
		expect(estimateTaskSessionGeometryMock).not.toHaveBeenCalled();
	});

	it("waits for a terminal geometry report before falling back", async () => {
		getTerminalGeometryMock.mockReturnValueOnce(null).mockReturnValueOnce({ cols: 132, rows: 38 });

		await expect(
			resolveTaskStartGeometry({
				taskId: "task-1",
				viewportWidth: 1440,
				viewportHeight: 900,
			}),
		).resolves.toEqual({ cols: 132, rows: 38 });

		expect(prepareWaitForTerminalGeometryMock).toHaveBeenCalledWith("task-1", 300);
		expect(estimateTaskSessionGeometryMock).not.toHaveBeenCalled();
	});

	it("falls back to the detached estimate when no frontend terminal reports geometry", async () => {
		getTerminalGeometryMock.mockReturnValue(null);
		estimateTaskSessionGeometryMock.mockReturnValue({ cols: 160, rows: 53 });

		await expect(
			resolveTaskStartGeometry({
				taskId: "task-1",
				viewportWidth: 1440,
				viewportHeight: 900,
			}),
		).resolves.toEqual({ cols: 160, rows: 53 });

		expect(estimateTaskSessionGeometryMock).toHaveBeenCalledWith(1440, 900);
	});
});
