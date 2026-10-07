import { listDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import type { DesktopLabProcess } from "./desktop-types";

/** A disconnected renderer is not proof that its old helper released the listener. */
export async function waitForDesktopHelperExit(
	helper: DesktopLabProcess,
	options: { listProcesses?: () => Promise<DesktopLabProcess[]>; timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + (options.timeoutMs ?? 45_000);
	const list = options.listProcesses ?? listDesktopProcesses;
	do {
		if (!(await list()).some((process) => sameDesktopProcess(process, helper))) return;
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 100));
	} while (Date.now() < deadline);
	throw new Error("Desktop persistence did not confirm the exact original helper exited before reserving its port.");
}
