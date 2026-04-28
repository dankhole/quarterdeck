import { estimateTaskSessionGeometry, type TaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getTerminalGeometry, prepareWaitForTerminalGeometry } from "@/terminal/terminal-geometry-registry";

const TASK_TERMINAL_GEOMETRY_WAIT_MS = 300;
const CACHED_TASK_TERMINAL_GEOMETRY_SETTLE_MS = 100;

interface ResolveTaskStartGeometryOptions {
	taskId: string;
	viewportWidth: number;
	viewportHeight: number;
	waitMs?: number;
	cachedWaitMs?: number;
}

export async function resolveTaskStartGeometry({
	taskId,
	viewportWidth,
	viewportHeight,
	waitMs = TASK_TERMINAL_GEOMETRY_WAIT_MS,
	cachedWaitMs = CACHED_TASK_TERMINAL_GEOMETRY_SETTLE_MS,
}: ResolveTaskStartGeometryOptions): Promise<TaskSessionGeometry> {
	const existingGeometry = getTerminalGeometry(taskId);
	const fallbackGeometry = () => estimateTaskSessionGeometry(viewportWidth, viewportHeight);
	if (existingGeometry) {
		await prepareWaitForTerminalGeometry(taskId, cachedWaitMs)();
		return getTerminalGeometry(taskId) ?? fallbackGeometry();
	}

	await prepareWaitForTerminalGeometry(taskId, waitMs)();

	return getTerminalGeometry(taskId) ?? fallbackGeometry();
}
