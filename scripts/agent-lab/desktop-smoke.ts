import type { Dirent } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import type { Page } from "playwright-core";

import { exerciseDesktopCompareWindow, validateDesktopCompareWindowSelection } from "./desktop-compare-window";
import { DesktopLabDriver, withDesktopDeadline } from "./desktop-driver";
import { exerciseDesktopEnvironmentSettings } from "./desktop-environment-settings";
import type {
	DesktopDocumentEvaluationModule,
	DesktopEvaluationModule,
	DesktopMenuEvaluationModule,
} from "./desktop-evaluation-types";
import { readDesktopFakeHistory } from "./desktop-fake-history";
import {
	assertDesktopFakeProcessOwnership,
	projectDesktopFakeReadiness,
	projectDesktopFakeReadinessDiagnostic,
} from "./desktop-fake-readiness";
import { assertDesktopFakeExactRecovery, assertDesktopFakeInvocationOwnership } from "./desktop-fake-recovery";
import { prepareDesktopLabFixture } from "./desktop-fixture";
import { waitForDesktopHelperExit } from "./desktop-helper-exit";
import { exerciseDesktopMainLoss } from "./desktop-main-loss-scenario";
import { exerciseDesktopManualShells, validateDesktopManualShellSelection } from "./desktop-manual-shells";
import { DesktopNativeExperienceError, exerciseDesktopNativeExperience } from "./desktop-native-experience";
import { exerciseDesktopNotifications, validateDesktopNotificationSelection } from "./desktop-notifications";
import {
	assertDesktopNpmInitialProject,
	exerciseDesktopNpmLaunch,
	prepareDesktopNpmLaunch,
} from "./desktop-npm-launch";
import { exercisePackagedDesktopPerformance } from "./desktop-performance-run";
import { validateDesktopPerformanceSelection } from "./desktop-performance-scenario";
import { collectOwnedDesktopProcesses, listDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import { exerciseDesktopLifecycleCoverage, exerciseDesktopProductCoverage } from "./desktop-product-coverage";
import { validateDesktopProviderSelection } from "./desktop-provider";
import { exerciseDesktopRealProvider } from "./desktop-real-scenario";
import { exerciseDesktopRendererRecovery, openDesktopPrimaryProject } from "./desktop-renderer-recovery";
import { DesktopSecondLaunchError, proveDesktopSecondLaunch } from "./desktop-second-launch";
import { readDesktopTaskSession } from "./desktop-session-evidence";
import {
	exerciseDesktopSessionRecovery,
	prepareDesktopSessionRecovery,
	validateDesktopSessionRecoverySelection,
} from "./desktop-session-recovery";
import { exerciseWindowsTerminalFocus } from "./desktop-terminal-focus";
import { type DesktopAgentMode, DesktopProcessEvidenceSchema } from "./desktop-types";
import { proveWindowsChromiumCustody } from "./desktop-windows-custody";
import { assertWindowsDesktopInUse, finishWindowsDesktopLifecycle } from "./desktop-windows-fixture";
import { readFakeInvocationReceipt } from "./fake-invocation-receipt";
import { writeJsonAtomic } from "./paths";

async function waitFor(condition: () => Promise<boolean>, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Desktop smoke timed out waiting for ${label}.`);
}

async function dismissOnboarding(page: Page): Promise<void> {
	const onboarding = page.getByRole("dialog", { name: "Get started" });
	if (await onboarding.isVisible()) await page.keyboard.press("Escape");
}

async function invokeNativeMenu(driver: DesktopLabDriver, id: "desktop.reload" | "desktop.restartRuntime") {
	await waitFor(
		() =>
			driver.app.evaluate(
				({ Menu }: DesktopMenuEvaluationModule, menuId) =>
					Menu.getApplicationMenu()?.getMenuItemById(menuId)?.enabled === true,
				id,
			),
		`enabled native ${id} command`,
	);
	await driver.app.evaluate(({ Menu }: DesktopMenuEvaluationModule, menuId) => {
		const item = Menu.getApplicationMenu()?.getMenuItemById(menuId);
		if (!item?.enabled) throw new Error("Native desktop menu command became unavailable.");
		item.click(item, undefined, { triggeredByAccelerator: false });
	}, id);
}

async function readMountedDocument(driver: DesktopLabDriver) {
	return driver.app.evaluate(({ BrowserWindow }: DesktopDocumentEvaluationModule) => {
		const windows = BrowserWindow.getAllWindows().filter((window) =>
			window.webContents.getURL().startsWith("app://quarterdeck/"),
		);
		const window = windows[0];
		if (windows.length !== 1 || !window) throw new Error("Expected one isolated product document.");
		return { windowId: window.id, webContentsId: window.webContents.id };
	});
}

export async function assertRendererIsolation(page: Page): Promise<void> {
	const globals = await page.evaluate(() => ({
		nodeRequire: "require" in globalThis,
		nodeProcess: "process" in globalThis,
	}));
	if (!page.url().startsWith("app://quarterdeck/"))
		throw new Error("Desktop renderer did not use its stable private origin.");
	if (globals.nodeRequire || globals.nodeProcess) throw new Error("Desktop renderer exposed Node globals.");
}

async function findPtyProof(directory: string): Promise<string | null> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	for (const entry of entries) {
		if (entry.isFile() && entry.name === "desktop-smoke-proof.txt") {
			const path = join(directory, entry.name);
			if ((await readFile(path, "utf8")).trim() === "packaged-pty-verified") return path;
		}
		if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") {
			const found = await findPtyProof(join(directory, entry.name));
			if (found) return found;
		}
	}
	return null;
}

export async function exerciseFakeAgent(page: Page, driver: DesktopLabDriver, confirmWorking = false): Promise<string> {
	await page.locator("section.kb-board").waitFor({ state: "visible" });
	const existingTasks = new Set(
		await page
			.locator("[data-task-id]")
			.evaluateAll((cards) =>
				cards.map((card) => card.getAttribute("data-task-id")).filter((id): id is string => id !== null),
			),
	);
	await page.getByRole("button", { name: "Create task", exact: true }).first().click();
	const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task" }) });
	await dialog.getByPlaceholder("Describe the task").fill("[agent-lab:idle] packaged desktop smoke");
	await dialog.getByRole("button", { name: "Task harness", exact: true }).click();
	await driver.inspect("agent-options");
	await page.getByRole("menuitem", { name: /Codex/ }).click();
	await driver.inspect("task-dialog");
	await dialog.getByRole("button", { name: "Start task", exact: true }).click();
	await dialog.waitFor({ state: "hidden" });
	let createdTaskId: string | undefined;
	await waitFor(async () => {
		createdTaskId = (
			await page
				.locator("[data-task-id]")
				.evaluateAll((cards) =>
					cards.map((card) => card.getAttribute("data-task-id")).filter((id): id is string => id !== null),
				)
		).find((id) => !existingTasks.has(id));
		return createdTaskId !== undefined;
	}, "new task identity");
	const taskId = createdTaskId;
	if (!taskId) throw new Error("Desktop task did not expose its identity.");
	await page.locator(`[data-task-id="${taskId}"]`).first().click();
	const input = page.getByRole("textbox", { name: "Terminal input" });
	await input.waitFor({ state: "visible" });
	try {
		await waitFor(async () => {
			const session = await readDesktopTaskSession(driver.fixture.config.stateHome, taskId);
			const readiness = session && projectDesktopFakeReadiness(session, taskId);
			if (!readiness) return false;
			const helper = driver.fixture.manifest.processes.find(
				(process) => process.pid === driver.fixture.manifest.helperPid,
			);
			if (!helper) throw new Error("Fake readiness has no captured owned helper identity.");
			const agent = assertDesktopFakeProcessOwnership(readiness.pid, helper, await listDesktopProcesses());
			await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "fake-readiness.json"), {
				...readiness,
				processBirth: agent.startedAt,
			});
			return true;
		}, "current fake launch startup hook and owned process");
	} catch (error) {
		try {
			const summary = await readDesktopTaskSession(driver.fixture.config.stateHome, taskId);
			const helper = driver.fixture.manifest.processes.find(
				(process) => process.pid === driver.fixture.manifest.helperPid,
			);
			const owned = helper ? collectOwnedDesktopProcesses(await listDesktopProcesses(), [], [helper]) : [];
			const receipt = summary?.sessionInstanceId
				? await readFakeInvocationReceipt({
						stateHome: driver.fixture.config.stateHome,
						sessionInstanceId: summary.sessionInstanceId,
					})
				: null;
			await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "fake-readiness-timeout.json"), {
				taskId,
				session: summary ? projectDesktopFakeReadinessDiagnostic(summary) : null,
				receipt,
				processes: owned.map((process) => ({
					pid: process.pid,
					parentPid: process.parentPid,
					startedAt: process.startedAt,
				})),
			});
		} catch {
			await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "fake-readiness-timeout.json"), {
				taskId,
				inspection: "unavailable",
			}).catch(() => undefined);
		}
		throw error;
	}
	await driver.inspect("agent-started");
	// Prove actual PTY input/output using a synthetic filesystem consequence,
	// independent of canvas paint and the build's optional terminal-text debug API.
	await input.focus();
	await page.keyboard.type("/write desktop-smoke-proof.txt packaged-pty-verified");
	await page.keyboard.press("Enter");
	let proofPath: string | null = null;
	await waitFor(async () => {
		proofPath =
			(await findPtyProof(join(driver.fixture.config.stateHome, "worktrees"))) ??
			(await findPtyProof(driver.fixture.config.projectPath));
		return proofPath !== null;
	}, "fake agent PTY filesystem consequence");
	const progressMarker = `packaged-recovery-${driver.fixture.manifest.runId}`;
	await page.keyboard.type(`/progress ${progressMarker}`);
	await page.keyboard.press("Enter");
	await waitFor(async () => {
		try {
			await readDesktopFakeHistory({ environment: driver.fixture.environment, taskId, marker: progressMarker });
			return true;
		} catch {
			return false;
		}
	}, "exact fixture-local fake conversation progress history");
	if (confirmWorking) {
		await page.keyboard.type("/working");
		await page.keyboard.press("Enter");
		await page
			.locator(`[data-task-id="${taskId}"]`)
			.filter({ hasText: "Running" })
			.first()
			.waitFor({ state: "visible" });
	}
	await page.keyboard.type("/review Packaged desktop PTY verified");
	await page.keyboard.press("Enter");
	await page.locator(`[data-task-id="${taskId}"]`).filter({ hasText: "Review" }).first().waitFor({ state: "visible" });
	await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "task-smoke.json"), {
		taskId,
		proofPath,
		historySeeded: true,
	});
	return taskId;
}

async function captureFakeConversation(driver: DesktopLabDriver, taskId: string) {
	const config = driver.fixture.config;
	const before = DesktopProcessEvidenceSchema.parse(
		JSON.parse(await readFile(config.processEvidencePath, "utf8")) as unknown,
	);
	const beforeSession = await readDesktopTaskSession(config.stateHome, taskId);
	const beforeLaunch = beforeSession && projectDesktopFakeReadiness(beforeSession, taskId);
	if (!beforeLaunch || beforeSession?.state !== "awaiting_review" || beforeSession.reviewReason !== "hook")
		throw new Error("Persistence recovery requires the exact live completed fake conversation.");
	const beforeReceipt = await readFakeInvocationReceipt({
		stateHome: config.stateHome,
		sessionInstanceId: beforeLaunch.sessionInstanceId,
	});
	const originalHelper = driver.fixture.manifest.processes.find((process) => process.pid === before.helperPid);
	if (!beforeReceipt || !originalHelper)
		throw new Error("Persistence recovery has no current fake invocation or owned helper evidence.");
	const oldInvocation = assertDesktopFakeInvocationOwnership({
		launch: beforeLaunch,
		receipt: beforeReceipt,
		helper: originalHelper,
		processes: await listDesktopProcesses(),
	});
	const historyBefore = await readDesktopFakeHistory({
		environment: driver.fixture.environment,
		taskId,
		marker: `packaged-recovery-${driver.fixture.manifest.runId}`,
	});
	return { before, beforeLaunch, beforeReceipt, originalHelper, oldInvocation, historyBefore };
}

async function exerciseRuntimePersistence(page: Page, driver: DesktopLabDriver, taskId: string): Promise<void> {
	const config = driver.fixture.config;
	const conversation = await captureFakeConversation(driver, taskId);
	const { before, originalHelper } = conversation;
	const documentMarker = driver.fixture.manifest.runId;
	await page.evaluate((marker) => {
		localStorage.setItem("quarterdeck.desktop-lab.persistence-proof", "synthetic-persisted-value");
		(
			globalThis as unknown as { __quarterdeckDesktopLabDocumentMarker: string }
		).__quarterdeckDesktopLabDocumentMarker = marker;
	}, documentMarker);
	const documentBefore = await readMountedDocument(driver);
	const productUrl = page.url();
	await driver.interruptOwnedHelper();
	const offline = page.getByRole("status").filter({
		has: page.getByRole("heading", { name: "Disconnected from Quarterdeck", exact: true }),
	});
	await offline.waitFor({ state: "visible", timeout: 45_000 });
	const documentAfterFailure = await readMountedDocument(driver);
	if (
		documentBefore.windowId !== documentAfterFailure.windowId ||
		documentBefore.webContentsId !== documentAfterFailure.webContentsId ||
		(await page.evaluate(
			() =>
				(globalThis as unknown as { __quarterdeckDesktopLabDocumentMarker?: string })
					.__quarterdeckDesktopLabDocumentMarker,
		)) !== documentMarker ||
		page.url() !== productUrl ||
		(await page.locator(`[data-task-id="${taskId}"]`).count()) === 0 ||
		(await page.evaluate(() => localStorage.getItem("quarterdeck.desktop-lab.persistence-proof"))) !==
			"synthetic-persisted-value"
	)
		throw new Error("Runtime failure did not preserve the mounted desktop product and local state.");
	await driver.inspect("runtime-stopped");
	if (!before.runtimeOrigin) throw new Error("Desktop did not identify its previous synthetic runtime origin.");
	const oldOrigin = new URL(before.runtimeOrigin);
	const oldPort = Number(oldOrigin.port);
	if (
		oldOrigin.protocol !== "http:" ||
		oldOrigin.hostname !== "127.0.0.1" ||
		!Number.isInteger(oldPort) ||
		oldPort <= 0
	)
		throw new Error("Cannot reserve an unverified synthetic runtime port.");
	// Reserve only this run's freed loopback port during the native restart
	// to require an endpoint change without changing product port selection.
	await waitForDesktopHelperExit(originalHelper);
	const reservation = createServer((socket) => socket.destroy());
	try {
		try {
			await new Promise<void>((resolve, reject) => {
				reservation.once("error", reject);
				reservation.listen(oldPort, "127.0.0.1", resolve);
			});
		} catch (error) {
			await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "runtime-port-reservation-failure.json"), {
				oldPort,
				originalHelperExited: true,
				originalHelper: { pid: originalHelper.pid, startedAt: originalHelper.startedAt },
				outcome:
					typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE"
						? "address_in_use"
						: "reservation_failed",
			}).catch(() => undefined);
			throw error;
		}
		await invokeNativeMenu(driver, "desktop.restartRuntime");
		await waitFor(
			async () => {
				const evidence = DesktopProcessEvidenceSchema.parse(
					JSON.parse(await readFile(config.processEvidencePath, "utf8")) as unknown,
				);
				return (
					evidence.phase === "ready" && Boolean(evidence.generation && evidence.generation !== before.generation)
				);
			},
			"native runtime restart with a new ready generation",
			45_000,
		);
		await offline.waitFor({ state: "hidden", timeout: 45_000 });
		await page.getByRole("button", { name: "Settings", exact: true }).waitFor({ state: "visible", timeout: 45_000 });
		await dismissOnboarding(page);
		await openDesktopPrimaryProject(page);
		await page.locator(`[data-task-id="${taskId}"]`).first().waitFor({ state: "visible" });
		await driver.markReady();
	} finally {
		if (reservation.listening) {
			await new Promise<void>((resolve, reject) => {
				reservation.close((error) => (error ? reject(error) : resolve()));
			});
		}
	}
	const after = DesktopProcessEvidenceSchema.parse(
		JSON.parse(await readFile(config.processEvidencePath, "utf8")) as unknown,
	);
	if (!before.generation || !after.generation || before.generation === after.generation)
		throw new Error("Native Restart Runtime did not replace the runtime generation.");
	if (!before.runtimeOrigin || !after.runtimeOrigin || before.runtimeOrigin === after.runtimeOrigin)
		throw new Error("Desktop storage acceptance requires an actual runtime port change.");
	const persisted = await page.evaluate(() => localStorage.getItem("quarterdeck.desktop-lab.persistence-proof"));
	if (persisted !== "synthetic-persisted-value")
		throw new Error("Desktop local storage was lost across runtime port change.");
	const recoveryProof = await verifyFakeConversationReplacement(driver, taskId, conversation, after.helperPid, true);
	await assertRendererIsolation(page);
	await driver.inspect("runtime-restarted");
	await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "persistence-smoke.json"), {
		before,
		after,
		taskId,
		stableOrigin: page.url(),
		storagePersisted: true,
		worktreePersisted: true,
		mountedProductPreservedWhileOffline: true,
		restartViaNativeMenu: true,
		documentBefore,
		documentAfterFailure,
		exactRecovery: recoveryProof,
	});
}

async function verifyFakeConversationReplacement(
	driver: DesktopLabDriver,
	taskId: string,
	conversation: Awaited<ReturnType<typeof captureFakeConversation>>,
	helperPid: number | null,
	requireReview: boolean,
): Promise<unknown> {
	const config = driver.fixture.config;
	const { beforeLaunch, beforeReceipt, oldInvocation, historyBefore } = conversation;
	if (!(await findPtyProof(join(config.stateHome, "worktrees"))) && !(await findPtyProof(config.projectPath)))
		throw new Error("Persisted packaged task worktree was lost across session replacement.");
	let recoveryProof: unknown = null;
	await waitFor(
		async () => {
			const session = await readDesktopTaskSession(config.stateHome, taskId);
			if (
				session?.sessionInstanceId &&
				session.sessionInstanceId !== beforeLaunch.sessionInstanceId &&
				session.pid === null &&
				session.exitCode !== null
			)
				throw new Error(`Replacement fake task exited with code ${session.exitCode} before proving exact resume.`);
			const launch = session && projectDesktopFakeReadiness(session, taskId);
			if (!launch || launch.sessionInstanceId === beforeLaunch.sessionInstanceId) return false;
			const receipt = await readFakeInvocationReceipt({
				stateHome: config.stateHome,
				sessionInstanceId: launch.sessionInstanceId,
			});
			if (!receipt) return false;
			assertDesktopFakeExactRecovery({ before: beforeLaunch, after: launch, beforeReceipt, afterReceipt: receipt });
			const processes = await listDesktopProcesses();
			const helper = driver.fixture.manifest.processes.find((process) => process.pid === helperPid);
			if (!helper) throw new Error("Recovered fake launch has no captured current helper identity.");
			const invocation = assertDesktopFakeInvocationOwnership({ launch, receipt, helper, processes });
			if (
				processes.some(
					(process) =>
						sameDesktopProcess(process, oldInvocation.pty) || sameDesktopProcess(process, oldInvocation.worker),
				)
			)
				throw new Error("Session replacement retained the previous exact fake process identity.");
			const reviewPreserved = session?.state === "awaiting_review" && session.reviewReason === "hook";
			if (requireReview && !reviewPreserved)
				throw new Error("Exact recovery did not preserve completed Review semantics.");
			const historyAfter = await readDesktopFakeHistory({
				environment: driver.fixture.environment,
				taskId,
				marker: `packaged-recovery-${driver.fixture.manifest.runId}`,
			});
			if (historyAfter.sha256 !== historyBefore.sha256 || historyAfter.bytes !== historyBefore.bytes)
				throw new Error("Exact recovery changed or lost the seeded fake conversation history.");
			recoveryProof = {
				before: beforeLaunch,
				after: launch,
				beforeReceipt,
				afterReceipt: receipt,
				beforeProcessBirth: oldInvocation.pty.startedAt,
				afterProcessBirth: invocation.pty.startedAt,
				beforeWorkerBirth: oldInvocation.worker.startedAt,
				afterWorkerBirth: invocation.worker.startedAt,
				oldProcessStopped: true,
				reviewPreserved,
				historyBefore,
				historyAfter,
				historyPreserved: true,
			};
			return true;
		},
		"targeted fake conversation recovery with a new owned PTY and native hook",
		90_000,
	);
	return recoveryProof;
}

async function exerciseWindowsTaskRestart(page: Page, driver: DesktopLabDriver, taskId: string): Promise<void> {
	const conversation = await captureFakeConversation(driver, taskId);
	const task = page.locator(`[data-task-id="${taskId}"]:visible`).first();
	await task.hover({ position: { x: 4, y: 4 } });
	const restart = task.getByRole("button", { name: /^(Force restart agent session|Restart agent session)$/ }).first();
	await restart.waitFor({ state: "visible" });
	await restart.press("Enter");
	const exactRecovery = await verifyFakeConversationReplacement(
		driver,
		taskId,
		conversation,
		conversation.originalHelper.pid,
		false,
	);
	await driver.inspect("task-restarted");
	await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "windows-task-restart.json"), {
		taskId,
		runtimeGeneration: conversation.before.generation,
		worktreePersisted: true,
		exactRecovery,
	});
}

export async function runDesktopSmoke(options: {
	appPath: string;
	name?: string;
	keepTemp?: boolean;
	artifactRoot?: string;
	includeAgent?: boolean;
	showWindow?: boolean;
	nativeExperience?: boolean;
	performance?: boolean;
	mainLoss?: boolean;
	sessionRecovery?: boolean;
	windowsTerminalFocus?: boolean;
	npmLaunch?: boolean;
	manualShells?: boolean;
	compareWindow?: boolean;
	notifications?: boolean;
	agentMode?: DesktopAgentMode;
}): Promise<{ runId: string; manifestPath: string; artifactDir: string }> {
	if (!["darwin", "win32"].includes(process.platform))
		throw new Error("Packaged desktop smoke requires macOS or Windows.");
	if (
		process.platform === "win32" &&
		(options.mainLoss ||
			options.npmLaunch ||
			options.performance ||
			(options.nativeExperience && options.showWindow) ||
			(options.agentMode ?? "fake") !== "fake")
	)
		throw new Error(
			"Windows Agent Lab requires the fake provider. Npm-launch, main-loss, performance and visible native experience require macOS.",
		);
	if (
		options.windowsTerminalFocus &&
		(process.platform !== "win32" ||
			options.includeAgent === false ||
			options.showWindow ||
			options.nativeExperience ||
			options.performance ||
			options.mainLoss ||
			options.sessionRecovery ||
			options.npmLaunch ||
			options.manualShells ||
			options.compareWindow ||
			options.notifications)
	)
		throw new Error("--windows-terminal-focus requires a hidden Windows fake-provider run with no other scenario.");
	if (options.compareWindow) validateDesktopCompareWindowSelection(options);
	if (options.sessionRecovery) validateDesktopSessionRecoverySelection(options);
	if (options.notifications) validateDesktopNotificationSelection(options);
	validateDesktopProviderSelection(options.agentMode ?? "fake", options.includeAgent !== false);
	if (options.manualShells) validateDesktopManualShellSelection(options);
	if (options.performance) validateDesktopPerformanceSelection(options);
	if (options.mainLoss && (options.includeAgent === false || (options.agentMode ?? "fake") !== "fake"))
		throw new Error("Desktop main-process recovery requires the isolated fake-provider scenario.");
	if (options.mainLoss && options.showWindow)
		throw new Error("Desktop main-process recovery requires a hidden isolated window.");
	if (
		options.npmLaunch &&
		(options.includeAgent !== false ||
			options.showWindow ||
			options.nativeExperience ||
			options.performance ||
			options.mainLoss ||
			options.manualShells ||
			(options.agentMode ?? "fake") !== "fake")
	)
		throw new Error("Packaged npm launch checks require --no-agent, a hidden window, and no other scenario.");
	const fixture = await prepareDesktopLabFixture(options);
	let driver = new DesktopLabDriver(fixture);
	let failure: unknown;
	let cleanupFailure: unknown;
	// The installed experimental Electron SDK creates parallel handshake promises.
	// An early executable exit may reject a sibling before the SDK awaits it.
	// Keep the run's cleanup path active instead of letting Node abandon owned state.
	const handleUnhandledRejection = (error: unknown): void => {
		failure ??= error;
		void driver.stop(failure).catch((cleanupError: unknown) => {
			cleanupFailure = cleanupError;
		});
	};
	process.on("unhandledRejection", handleUnhandledRejection);
	const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
		const handler = (): void => {
			failure ??= new Error(`Desktop Agent Lab interrupted by ${signal}.`);
			void driver.stop(failure).catch((error: unknown) => {
				cleanupFailure = error;
			});
		};
		process.once(signal, handler);
		return { signal, handler };
	});
	try {
		const npmPreparation = options.npmLaunch
			? await driver.prepareFixture(() => prepareDesktopNpmLaunch(fixture))
			: null;
		const recoverySeed = options.sessionRecovery
			? await driver.prepareFixture(() => prepareDesktopSessionRecovery(fixture))
			: null;
		let page = await driver.launch();
		if (recoverySeed) {
			await exerciseDesktopSessionRecovery(page, driver, recoverySeed);
		} else {
			await page
				.getByRole("button", { name: "Settings", exact: true })
				.waitFor({ state: "visible", timeout: 45_000 });
			await dismissOnboarding(page);
			if (npmPreparation) await assertDesktopNpmInitialProject(page, fixture);
			else await openDesktopPrimaryProject(page);
		}
		await assertRendererIsolation(page);
		await driver.markReady();
		await driver.inspect("ready");
		const windows = process.platform === "win32";
		if (windows) {
			await proveWindowsChromiumCustody(driver);
			await assertWindowsDesktopInUse(fixture);
		}
		if (recoverySeed) {
			await driver.inspect("completed");
		} else if (npmPreparation) {
			await exerciseDesktopNpmLaunch(page, driver, npmPreparation);
		} else if (options.compareWindow) {
			await exerciseDesktopCompareWindow(page, driver);
			await driver.inspect("completed");
		} else if (options.manualShells) {
			await exerciseDesktopManualShells(page, driver);
			await driver.inspect("completed");
		} else if (options.notifications) {
			try {
				await exerciseDesktopNotifications(page, driver, () => exerciseFakeAgent(page, driver, true));
			} finally {
				const settings = page.getByRole("dialog", { name: "Settings", exact: true });
				if (await settings.isVisible()) await settings.getByRole("button", { name: "Cancel", exact: true }).click();
			}
			await driver.inspect("completed");
		} else if (options.windowsTerminalFocus) {
			const taskId = await exerciseFakeAgent(page, driver);
			await exerciseWindowsTerminalFocus(page, driver, taskId);
			driver.sockets.assertTraffic();
			await driver.inspect("completed");
		} else if (options.performance) {
			const taskId = await exerciseFakeAgent(page, driver);
			await exercisePackagedDesktopPerformance(page, driver, taskId);
			driver.sockets.assertTraffic();
			await driver.inspect("completed");
		} else {
			if (!windows && (!options.agentMode || options.agentMode === "fake"))
				await exerciseDesktopEnvironmentSettings(page, driver);
			if (options.nativeExperience) {
				try {
					const proof = await exerciseDesktopNativeExperience(page, driver);
					await writeJsonAtomic(join(fixture.manifest.artifactDir, "native-experience.json"), proof);
				} catch (error) {
					if (error instanceof DesktopNativeExperienceError)
						await writeJsonAtomic(join(fixture.manifest.artifactDir, "native-experience-failure.json"), {
							failureStage: error.failureStage,
							restorationConfirmed: error.restorationConfirmed,
							diagnostic: error.diagnostic,
						});
					throw error;
				}
			}
			if (!fixture.config.showWindow && (!options.agentMode || options.agentMode === "fake")) {
				try {
					const launchOptions = {
						readSecondInstanceCount: await driver.observeSecondInstances(),
					};
					const proof = windows
						? await driver.proveSecondLaunch(launchOptions)
						: await proveDesktopSecondLaunch(fixture, launchOptions);
					await writeJsonAtomic(join(fixture.manifest.artifactDir, "second-launch-proof.json"), proof);
					await driver.inspect("second-launch");
				} catch (error) {
					if (error instanceof DesktopSecondLaunchError && !error.cleanupConfirmed)
						driver.retainSecondaryLaunchProcesses(error.secondProcesses);
					throw error;
				}
			}
			await page.keyboard.press(windows ? "Control+Shift+S" : "Meta+Shift+S");
			await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "visible" });
			await page.keyboard.press("Escape");
			await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "hidden" });
			const helperPid = fixture.manifest.helperPid;
			if (!windows && fixture.config.showWindow && !options.nativeExperience) {
				await driver.app.evaluate(({ BrowserWindow }: DesktopEvaluationModule) =>
					BrowserWindow.getAllWindows()[0]?.close(),
				);
				const hidden = await driver.app.evaluate(({ BrowserWindow }: DesktopEvaluationModule) =>
					BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
				);
				if (!hidden) throw new Error("Closing the desktop window did not hide it.");
				await driver.inspect("window-hidden");
				if (fixture.manifest.helperPid !== helperPid) throw new Error("Window close replaced the runtime helper.");
				await driver.app.evaluate(({ app }: DesktopEvaluationModule) => {
					app.emit("activate");
				});
				await waitFor(
					() =>
						driver.app.evaluate(({ BrowserWindow }: DesktopEvaluationModule) =>
							BrowserWindow.getAllWindows().some((window) => window.isVisible()),
						),
					"Dock reopen",
				);
			}
			await Promise.all([
				page.waitForEvent("domcontentloaded", { timeout: 25_000 }),
				invokeNativeMenu(driver, "desktop.reload"),
			]);
			await page.getByRole("button", { name: "Settings", exact: true }).waitFor({ state: "visible" });
			await dismissOnboarding(page);
			await openDesktopPrimaryProject(page);
			await assertRendererIsolation(page);
			await driver.inspect("renderer-reloaded");
			if (fixture.manifest.helperPid !== helperPid) throw new Error("Renderer reload replaced the runtime helper.");
			if (options.agentMode && options.agentMode !== "fake") {
				await exerciseDesktopRealProvider(page, driver);
			} else if (options.includeAgent !== false) {
				if (!fixture.config.showWindow) page = await exerciseDesktopRendererRecovery(page, driver);
				await exerciseDesktopProductCoverage(page, driver);
				const taskId = await exerciseFakeAgent(page, driver, false);
				if (windows) await exerciseWindowsTerminalFocus(page, driver, taskId);
				await exerciseDesktopLifecycleCoverage(page, driver, taskId);
				driver.sockets.assertTraffic();
				if (options.mainLoss) {
					const recovered = await exerciseDesktopMainLoss(page, driver, taskId, {
						setCleanupOwner: (replacement) => {
							driver = replacement;
						},
					});
					page = recovered.page;
				} else if (windows) {
					await exerciseWindowsTaskRestart(page, driver, taskId);
				} else {
					await exerciseRuntimePersistence(page, driver, taskId);
				}
			}
			await driver.inspect("completed");
		}
	} catch (error) {
		failure = error;
		await writeFile(
			join(fixture.manifest.artifactDir, "failure.txt"),
			error instanceof Error ? (error.stack ?? error.message) : String(error),
			"utf8",
		);
		try {
			await withDesktopDeadline(driver.inspect("failed"), "Desktop failure inspection", 5_000);
		} catch {
			/* Preserve original failure. */
		}
	} finally {
		try {
			await driver.stop(failure);
		} catch (error) {
			cleanupFailure = error;
		}
		for (const { signal, handler } of signalHandlers) process.removeListener(signal, handler);
		process.removeListener("unhandledRejection", handleUnhandledRejection);
	}
	if (failure || cleanupFailure)
		throw new Error(
			[
				failure instanceof Error ? failure.message : failure ? String(failure) : null,
				cleanupFailure instanceof Error ? cleanupFailure.message : cleanupFailure ? String(cleanupFailure) : null,
				`Desktop evidence: ${fixture.manifestPath}`,
			]
				.filter(Boolean)
				.join("\n"),
		);
	if (process.platform === "win32") {
		try {
			await finishWindowsDesktopLifecycle(fixture);
			if (!options.keepTemp) await rm(fixture.config.tempRoot, { recursive: true, force: true });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`${detail}\nDesktop evidence: ${fixture.manifestPath}`, { cause: error });
		}
	}
	return {
		runId: fixture.manifest.runId,
		manifestPath: fixture.manifestPath,
		artifactDir: fixture.manifest.artifactDir,
	};
}
