import { join } from "node:path";
import type { Page } from "playwright-core";
import type { DesktopLabDriver } from "./desktop-driver";
import { readDesktopFakeHistory } from "./desktop-fake-history";
import { DesktopPerformanceScenarioError, exerciseDesktopPerformanceScenario } from "./desktop-performance-scenario";
import { readDesktopTaskSession } from "./desktop-session-evidence";
import { writeJsonAtomic } from "./paths";

interface RendererMeasurement {
	performance: { now(): number };
	innerWidth: number;
	innerHeight: number;
	__quarterdeckDumpTerminalState?: () => { poolSlots: Array<{ taskId: string; visibleLines: string[] }> };
}

/** The existing packaged owner admits processes, captures evidence and always owns final cleanup. */
export async function exercisePackagedDesktopPerformance(
	page: Page,
	driver: DesktopLabDriver,
	taskId: string,
): Promise<void> {
	const fixture = driver.fixture;
	const session = await readDesktopTaskSession(fixture.config.stateHome, taskId);
	const mainPid = fixture.manifest.mainPid;
	const helperPid = fixture.manifest.helperPid;
	if (!session?.sessionInstanceId || !mainPid || !helperPid)
		throw new Error("Desktop measurement requires its admitted main/helper and exact live fake task.");
	const projectId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "");
	const hasTerminalContent = await page.evaluate(
		(id) =>
			(globalThis as unknown as RendererMeasurement)
				.__quarterdeckDumpTerminalState?.()
				.poolSlots.some((slot) => slot.taskId === id && slot.visibleLines.some((line) => line.length > 0)) === true,
		taskId,
	);
	const currentSession = session;
	try {
		const evidence = await exerciseDesktopPerformanceScenario(
			{
				runId: fixture.manifest.runId,
				projectId,
				taskId,
				desktopMainPid: mainPid,
				runtimeHelperPid: helperPid,
				conditions: { desktopVisible: fixture.config.showWindow === true },
				readAdmittedDesktop: async () => {
					await driver.inspect("performance-admission");
					return fixture.manifest.processes;
				},
			},
			{
				navigate: async () => {
					const before = await page.evaluate(() =>
						(globalThis as unknown as RendererMeasurement).performance.now(),
					);
					await page.getByRole("button", { name: "Home", exact: true }).click();
					await page.locator("section.kb-board").waitFor({ state: "visible" });
					await page.locator(`[data-task-id="${taskId}"]`).first().click();
					await page.getByRole("textbox", { name: "Terminal input" }).waitFor({ state: "visible" });
					return await page.evaluate((started) => {
						const renderer = globalThis as unknown as RendererMeasurement;
						return {
							boundary: "ui-action-to-terminal-visible" as const,
							clock: "renderer-monotonic" as const,
							durationMs: renderer.performance.now() - started,
							viewport: { width: renderer.innerWidth, height: renderer.innerHeight },
						};
					}, before);
				},
				progress: hasTerminalContent
					? {
							mode: "required",
							acknowledge: async (_client, marker) => {
								const input = page.getByRole("textbox", { name: "Terminal input" });
								await input.focus();
								await page.keyboard.type(`/progress ${marker}`);
								await page.keyboard.press("Enter");
								const response = `AGENT LAB PROGRESS: ${marker}`;
								await page.waitForFunction(
									({ id, text }) =>
										(globalThis as unknown as RendererMeasurement)
											.__quarterdeckDumpTerminalState?.()
											.poolSlots.find((slot) => slot.taskId === id)
											?.visibleLines.join("\n")
											.includes(text) === true,
									{ id: taskId, text: response },
									{ timeout: 25_000 },
								);
								await readDesktopFakeHistory({ environment: fixture.environment, taskId, marker });
								return { terminalResponse: response, historyMarker: marker };
							},
						}
					: { mode: "unavailable", reason: "production-terminal-content-disabled" },
				verifyScope: async () => {
					const current = await readDesktopTaskSession(fixture.config.stateHome, taskId);
					if (
						!current ||
						fixture.manifest.mainPid !== mainPid ||
						fixture.manifest.helperPid !== helperPid ||
						current?.sessionInstanceId !== currentSession.sessionInstanceId ||
						current.pid !== currentSession.pid ||
						current.resumeSessionId !== currentSession.resumeSessionId ||
						decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "") !== projectId
					)
						throw new Error("Desktop measurement scope or exact native task identity changed.");
				},
			},
		);
		await writeJsonAtomic(join(fixture.manifest.artifactDir, "desktop-performance.json"), evidence);
	} catch (error) {
		if (error instanceof DesktopPerformanceScenarioError)
			await writeJsonAtomic(join(fixture.manifest.artifactDir, "desktop-performance-failure.json"), error.evidence);
		throw error;
	}
}
