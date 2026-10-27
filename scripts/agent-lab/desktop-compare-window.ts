import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { runtimeProjectStateResponseSchema } from "../../src/core/api/project-state";
import { parseCompareWindowTarget } from "../../src/shared/compare-window-contract";
import type { DesktopLabDriver } from "./desktop-driver";
import type { DesktopDocumentEvaluationModule, DesktopEvaluationModule } from "./desktop-evaluation-types";
import { writeJsonAtomic } from "./paths";

export function validateDesktopCompareWindowSelection(options: {
	includeAgent?: boolean;
	showWindow?: boolean;
	agentMode?: string;
	nativeExperience?: boolean;
	performance?: boolean;
	mainLoss?: boolean;
	sessionRecovery?: boolean;
	npmLaunch?: boolean;
	manualShells?: boolean;
	notifications?: boolean;
}): void {
	if (
		options.includeAgent !== false ||
		options.showWindow ||
		(options.agentMode ?? "fake") !== "fake" ||
		options.nativeExperience ||
		options.performance ||
		options.mainLoss ||
		options.sessionRecovery ||
		options.npmLaunch ||
		options.manualShells ||
		options.notifications
	) {
		throw new Error("Compare window checks require --no-agent, a hidden window, fake mode, and no other scenario.");
	}
}

async function readMainDocument(page: Page, driver: DesktopLabDriver) {
	return await driver.app.evaluate(({ BrowserWindow }: DesktopDocumentEvaluationModule, url) => {
		const allWindows = BrowserWindow.getAllWindows();
		const windows = allWindows.filter((window) => window.webContents.getURL() === url);
		if (windows.length !== 1 || !windows[0]) throw new Error("Expected the exact original main product document.");
		return { windowId: windows[0].id, webContentsId: windows[0].webContents.id, windowCount: allWindows.length };
	}, page.url());
}

async function assertNoLiveSessions(page: Page, projectId: string): Promise<number> {
	const raw: unknown = await page.evaluate(async (id) => {
		const response = await fetch("/api/trpc/project.getState", {
			headers: { "x-quarterdeck-project-id": id },
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) throw new Error("Compare scenario project query failed.");
		const text = await response.text();
		if (text.length > 2 * 1024 * 1024) throw new Error("Compare scenario project query exceeds its bound.");
		const body: unknown = JSON.parse(text);
		const result: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "result") : null;
		if (typeof result !== "object" || result === null) throw new Error("Missing Compare scenario project state.");
		return Reflect.get(result, "data") as unknown;
	}, projectId);
	const state = runtimeProjectStateResponseSchema.parse(raw);
	const live = Object.values(state.sessions).filter((session) => session.pid !== null);
	if (live.length !== 0) throw new Error("Compare-only review unexpectedly owns a live terminal or agent session.");
	return live.length;
}

/** Hidden, no-provider proof: a real packaged preload and independent renderer, without crash/recovery. */
export async function exerciseDesktopCompareWindow(page: Page, driver: DesktopLabDriver): Promise<void> {
	const fixture = driver.fixture;
	const projectId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "");
	if (!projectId) throw new Error("Compare scenario requires the selected synthetic project.");
	const originalMain = await readMainDocument(page, driver);
	if (originalMain.windowCount !== 1) throw new Error("Compare scenario requires exactly the isolated main window.");
	const helperPid = fixture.manifest.helperPid;
	const nonce = `compare-window-${fixture.manifest.runId}`;
	await page.evaluate((value) => Reflect.set(globalThis, "__quarterdeckCompareWindowProof", value), nonce);
	const beforeLiveSessions = await assertNoLiveSessions(page, projectId);
	const marker = "standalone-compare-packaged-proof";
	const path = join(fixture.config.projectPath, "example.ts");
	await writeFile(path, `${await readFile(path, "utf8")}\nexport const compareWindowProof = "${marker}";\n`, "utf8");
	await page.getByRole("button", { name: "Git", exact: true }).click();
	await page.getByRole("button", { name: "Compare", exact: true }).click();
	// These labels belong to the owning Compare bar; avoid the unrelated top-bar branch picker.
	const bar = page.locator('label[for="compare-three-dot-diff"]').locator("..");
	for (const index of [0, 1]) {
		await bar.getByRole("button", { name: "Switch branch", exact: true }).nth(index).click();
		const picker = page.getByRole("dialog").filter({ has: page.getByPlaceholder("Filter branches...") });
		await picker.getByPlaceholder("Filter branches...").fill("main");
		await picker.getByRole("button", { name: "main", exact: true }).click();
		await picker.waitFor({ state: "hidden" });
	}
	const uncommitted = page.getByRole("checkbox", { name: "Include uncommitted work", exact: true });
	if ((await uncommitted.getAttribute("aria-checked")) !== "true") await uncommitted.click();
	await page.getByText(marker, { exact: false }).first().waitFor({ state: "visible" });
	let viewer: Page | null = null;
	const viewerFailures: Array<{ method: string; path: string; error: string | null }> = [];
	try {
		const opened = driver.app.waitForEvent("window", { timeout: 20_000 });
		await page.getByRole("button", { name: "Pop out Compare", exact: true }).click();
		viewer = await opened;
		viewer.on("requestfailed", (request) => {
			if (viewerFailures.length < 128)
				viewerFailures.push({
					method: request.method(),
					path: new URL(request.url()).pathname,
					error: request.failure()?.errorText ?? null,
				});
		});
		await viewer.getByRole("main", { name: "Standalone Compare", exact: true }).waitFor({ state: "visible" });
		await viewer.getByText(marker, { exact: false }).first().waitFor({ state: "visible" });
		const target = parseCompareWindowTarget(new URL(viewer.url()));
		if (
			!target ||
			target.projectId !== projectId ||
			target.taskId !== null ||
			target.sourceRef !== "main" ||
			target.targetRef !== "main" ||
			!target.includeUncommitted
		)
			throw new Error("Compare viewer lost its captured selection.");
		const viewerUrl = viewer.url();
		const isolation = await viewer.evaluate(() => {
			const bridge: unknown = Reflect.get(globalThis, "quarterdeckDesktop");
			return {
				bridgeKeys: bridge && typeof bridge === "object" ? Object.getOwnPropertyNames(bridge).sort() : [],
				nodeRequire: typeof Reflect.get(globalThis, "require") === "function",
				nodeProcess: typeof Reflect.get(globalThis, "process") !== "undefined",
				compareOpener: Reflect.has(globalThis, "quarterdeckDesktopCompare"),
				environment: Reflect.has(globalThis, "quarterdeckDesktopEnvironment"),
				updates: Reflect.has(globalThis, "quarterdeckDesktopUpdates"),
			};
		});
		if (
			JSON.stringify(isolation.bridgeKeys) !== JSON.stringify(["bootstrap", "version"]) ||
			isolation.nodeRequire ||
			isolation.nodeProcess ||
			isolation.compareOpener ||
			isolation.environment ||
			isolation.updates
		) {
			throw new Error("Compare renderer exposes capabilities beyond transport bootstrap.");
		}
		await page.getByRole("button", { name: "Home", exact: true }).click();
		await page.locator("section.kb-board").waitFor({ state: "visible" });
		if (viewer.url() !== viewerUrl) throw new Error("Main navigation redirected the Compare viewer.");
		await viewer.getByRole("main", { name: "Standalone Compare", exact: true }).waitFor({ state: "visible" });
		await viewer.getByText(marker, { exact: false }).first().waitFor({ state: "visible" });
		const duringLiveSessions = await assertNoLiveSessions(page, projectId);
		const duringMain = await readMainDocument(page, driver);
		if (
			duringMain.windowCount !== 2 ||
			duringMain.windowId !== originalMain.windowId ||
			duringMain.webContentsId !== originalMain.webContentsId
		) {
			throw new Error("Compare must add exactly one viewer without replacing the main window.");
		}
		await driver.inspect("compare-window-open");
		const sockets = driver.sockets.snapshot();
		if (sockets.some((socket) => socket.path !== "/api/runtime/ws"))
			throw new Error("Compare-only review opened a terminal socket.");
		if (sockets.filter((socket) => socket.path === "/api/runtime/ws" && socket.receivedFrames > 0).length < 2) {
			throw new Error("Both independent windows must receive authoritative runtime state.");
		}
		const closed = viewer.waitForEvent("close", { timeout: 10_000 });
		await driver.app.evaluate(({ BrowserWindow }: DesktopEvaluationModule, url) => {
			const viewers = BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL() === url);
			if (viewers.length !== 1 || !viewers[0])
				throw new Error("Expected exactly the owned Compare window to close.");
			viewers[0].close();
		}, viewerUrl);
		await closed;
		const afterMain = await readMainDocument(page, driver);
		if (
			JSON.stringify(afterMain) !== JSON.stringify(originalMain) ||
			fixture.manifest.helperPid !== helperPid ||
			(await page.evaluate(() => Reflect.get(globalThis, "__quarterdeckCompareWindowProof"))) !== nonce
		) {
			throw new Error("Compare close replaced the main product document or runtime helper.");
		}
		await page.locator("section.kb-board").waitFor({ state: "visible" });
		const afterLiveSessions = await assertNoLiveSessions(page, projectId);
		await driver.inspect("compare-window-closed");
		await writeJsonAtomic(join(fixture.manifest.artifactDir, "compare-window-proof.json"), {
			mode: "hidden-read-only-compare",
			providerTaskStarted: false,
			originalMain,
			afterMain,
			helperPid,
			target,
			isolation,
			liveSessions: { before: beforeLiveSessions, during: duringLiveSessions, after: afterLiveSessions },
			terminalSocketCount: 0,
			independentRuntimeStateConnections: sockets.length,
			nativeViewerCloseVerified: true,
			mainNavigationPreserved: true,
		});
	} catch (error) {
		// Capture the child before local cleanup; the outer runner's failure checkpoint sees only surviving windows.
		await driver.inspect("compare-window-failed").catch(() => undefined);
		await writeJsonAtomic(
			join(fixture.manifest.artifactDir, "compare-window-failed-requests.json"),
			viewerFailures,
		).catch(() => undefined);
		if (viewer && !viewer.isClosed()) {
			const transport = await viewer
				.evaluate(async () => {
					const bridge: unknown = Reflect.get(globalThis, "quarterdeckDesktop");
					let status: string | number;
					try {
						status = (await fetch("/api/trpc/runtime.getUiPreferences", { signal: AbortSignal.timeout(5_000) }))
							.status;
					} catch (error) {
						status = String(error);
					}
					return {
						status,
						bridgeKeys: bridge && typeof bridge === "object" ? Object.getOwnPropertyNames(bridge) : [],
					};
				})
				.catch((error: unknown) => ({ error: String(error) }));
			await writeJsonAtomic(
				join(fixture.manifest.artifactDir, "compare-window-failed-transport.json"),
				transport,
			).catch(() => undefined);
			const snapshot = await viewer
				.locator("body")
				.ariaSnapshot()
				.catch(() => null);
			if (snapshot !== null)
				await writeFile(
					join(fixture.manifest.artifactDir, "compare-window-failed-viewer.aria.txt"),
					snapshot,
				).catch(() => undefined);
		}
		throw error;
	} finally {
		// Normal driver shutdown remains authoritative if a failed assertion leaves native cleanup unresolved.
		if (viewer && !viewer.isClosed()) await viewer.close().catch(() => undefined);
	}
}
