import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { readLabLaunchConfig } from "../../desktop/src/lab-launch-config.js";
import { runtimeProjectStateResponseSchema } from "../../src/core/api/project-state.js";
import { verifyRuntimeOwner } from "../../src/server/runtime-owner-client.js";
import { discoverRuntimeOwner } from "../../src/server/runtime-ownership.js";
import { withLabBrowserAdmissionScript } from "./browser-runtime-access";
import { closeAgentLabBrowserSession } from "./browser-session";
import { withDesktopDeadline } from "./desktop-driver";
import type { DesktopLabFixture } from "./desktop-fixture";
import { type PerformanceNavigationTiming, parsePerformanceNavigationTiming } from "./desktop-performance";
import {
	DesktopPerformanceScenarioError,
	type DesktopPerformanceScenarioEvidence,
	type DesktopPerformanceScenarioScope,
	exerciseDesktopPerformanceScenario,
} from "./desktop-performance-scenario";
import { DesktopProcessEvidenceSchema } from "./desktop-types";
import { AGENT_LAB_REPO_ROOT, writeJsonAtomic } from "./paths";

class DesktopBrowserWrapperCommandUnconfirmedError extends Error {
	constructor() {
		super("Desktop/browser wrapper command is unconfirmed; retain the synthetic fixture.");
	}
}

function runBoundedBrowserCommand(
	createChild: () => ChildProcess,
	timeoutMs = 30_000,
	maxBytes = 512 * 1024,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = createChild();
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const finish = (unconfirmed: boolean, failed = false) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (unconfirmed) {
				// Do not signal the wrapper: its signal handler invokes legacy process-tree kills.
				child.unref();
				if (child.stdout instanceof Socket) child.stdout.unref();
				if (child.stderr instanceof Socket) child.stderr.unref();
				reject(new DesktopBrowserWrapperCommandUnconfirmedError());
			} else if (failed) reject(new Error("Desktop/browser wrapper command failed; private output withheld."));
			else resolve(Buffer.concat(chunks).toString("utf8"));
			chunks.length = 0;
		};
		const timeout = setTimeout(() => finish(true), timeoutMs);
		timeout.unref();
		const collect = (stdout: boolean) => (chunk: Buffer) => {
			if (settled) return;
			bytes += chunk.length;
			if (bytes > maxBytes) return finish(true);
			if (stdout) chunks.push(chunk);
		};
		child.stdout?.on("data", collect(true));
		child.stderr?.on("data", collect(false));
		child.once("error", () => finish(true));
		child.once("close", (exitCode) => finish(false, exitCode !== 0));
	});
}
const sizes = [
	{ width: 1180, height: 720 },
	{ width: 1460, height: 1040 },
] as const;

export interface DesktopBrowserOwnerEvidence {
	pid: number;
	creationIdentity: string;
	generation: string;
	origin: string;
}

export interface DesktopBrowserClientEvidence {
	revision: number;
	boardDigest: string;
	taskId: string;
	columnId: string;
	sessionInstanceId: string;
	providerSessionId: string;
	pid: number;
	state: string;
	viewportRows: number;
}

export interface DesktopBrowserCoexistencePorts {
	readOwner: () => Promise<DesktopBrowserOwnerEvidence>;
	readDesktop: () => Promise<DesktopBrowserClientEvidence>;
	openBrowser: () => Promise<void>;
	readBrowser: () => Promise<DesktopBrowserClientEvidence>;
	resize: (width: number, height: number) => Promise<void>;
	closeBrowser: () => Promise<void>;
	/** Optional measurement reuses this admitted browser; it must submit no provider input or board mutation. */
	measurePerformance?: () => Promise<DesktopPerformanceScenarioEvidence>;
}

export type DesktopBrowserCoexistenceFailureStage =
	| "open_browser"
	| "read_browser"
	| "resize"
	| "read_desktop"
	| "owner_check"
	| "viewport_check"
	| "performance"
	| "performance_check"
	| "close_browser"
	| "final_check";

export class DesktopBrowserCoexistenceError extends Error {
	readonly code = "DesktopBrowserCoexistenceFailed";
	constructor(
		readonly browserSession: string,
		readonly owner: DesktopBrowserOwnerEvidence,
		readonly cleanupConfirmed: boolean,
		readonly failureStage: DesktopBrowserCoexistenceFailureStage,
	) {
		super(
			cleanupConfirmed
				? "Desktop/browser coexistence proof failed; browser cleanup confirmed."
				: "Desktop/browser coexistence browser cleanup is unconfirmed; retain the synthetic fixture.",
		);
		this.name = "DesktopBrowserCoexistenceError";
	}
}

function assertOwner(before: DesktopBrowserOwnerEvidence, after: DesktopBrowserOwnerEvidence): void {
	if (
		before.pid !== after.pid ||
		before.creationIdentity !== after.creationIdentity ||
		before.generation !== after.generation ||
		before.origin !== after.origin
	)
		throw new Error("Desktop/browser coexistence changed the runtime owner.");
}

function assertClient(before: DesktopBrowserClientEvidence, after: DesktopBrowserClientEvidence): void {
	for (const key of [
		"revision",
		"boardDigest",
		"taskId",
		"columnId",
		"sessionInstanceId",
		"providerSessionId",
		"pid",
		"state",
	] as const)
		if (before[key] !== after[key])
			throw new Error("Desktop/browser coexistence changed authoritative task or process identity.");
	if (!before.sessionInstanceId || !before.providerSessionId || before.pid <= 0 || after.viewportRows <= 0)
		throw new Error("Desktop/browser coexistence lacks live native session evidence.");
}

/** The orchestration is injected so failure/cleanup contracts can be tested without launching a browser. */
async function proveCoexistence(session: string, ports: DesktopBrowserCoexistencePorts) {
	const owner = await ports.readOwner();
	let before: DesktopBrowserClientEvidence | null = null;
	const checkpoints: Array<{ desktop: DesktopBrowserClientEvidence; browser: DesktopBrowserClientEvidence }> = [];
	let stage: DesktopBrowserCoexistenceFailureStage = "read_desktop";
	let failureStage: DesktopBrowserCoexistenceFailureStage | null = null;
	let browserAttempted = false;
	let cleanupConfirmed = false;
	let performance: DesktopPerformanceScenarioEvidence | undefined;
	try {
		before = await ports.readDesktop();
		assertClient(before, before);
		stage = "open_browser";
		browserAttempted = true;
		await ports.openBrowser();
		stage = "read_browser";
		assertClient(before, await ports.readBrowser());
		for (const size of sizes) {
			stage = "resize";
			await ports.resize(size.width, size.height);
			stage = "read_desktop";
			const desktop = await ports.readDesktop();
			assertClient(before, desktop);
			stage = "read_browser";
			const browser = await ports.readBrowser();
			assertClient(before, browser);
			stage = "owner_check";
			assertOwner(owner, await ports.readOwner());
			checkpoints.push({ desktop, browser });
		}
		stage = "viewport_check";
		if (
			checkpoints[0]?.desktop.viewportRows === checkpoints[1]?.desktop.viewportRows ||
			checkpoints[0]?.browser.viewportRows === checkpoints[1]?.browser.viewportRows
		)
			throw new Error("Desktop/browser coexistence did not exercise both terminal viewport resizes.");
		if (ports.measurePerformance) {
			// Keep the original functional proof on both sides of the measurement, with its original baseline.
			stage = "performance_check";
			assertOwner(owner, await ports.readOwner());
			assertClient(before, await ports.readDesktop());
			assertClient(before, await ports.readBrowser());
			stage = "performance";
			performance = await ports.measurePerformance();
			stage = "performance_check";
			assertOwner(owner, await ports.readOwner());
			assertClient(before, await ports.readDesktop());
			assertClient(before, await ports.readBrowser());
		}
	} catch {
		failureStage = stage;
	} finally {
		try {
			if (browserAttempted) await ports.closeBrowser();
			cleanupConfirmed = true;
		} catch {
			failureStage ??= "close_browser";
		}
	}
	if (!failureStage && before) {
		try {
			assertOwner(owner, await ports.readOwner());
			assertClient(before, await ports.readDesktop());
		} catch {
			failureStage = "final_check";
		}
	}
	if (failureStage || !before)
		throw new DesktopBrowserCoexistenceError(session, owner, cleanupConfirmed, failureStage ?? "read_desktop");
	return { owner, browserSession: session, before, checkpoints, cleanupConfirmed: true as const, performance };
}

/** Preserve typed partial measurements before the existing browser owner's cleanup; never copy raw errors. */
async function recordPerformanceEvidence(
	exercise: () => Promise<DesktopPerformanceScenarioEvidence>,
	write: (evidence: DesktopPerformanceScenarioEvidence) => Promise<void>,
): Promise<DesktopPerformanceScenarioEvidence> {
	let evidence: DesktopPerformanceScenarioEvidence;
	try {
		evidence = await exercise();
	} catch (error) {
		if (error instanceof DesktopPerformanceScenarioError) await write(error.evidence);
		throw error;
	}
	await write(evidence);
	return evidence;
}

type PerformanceNavigationPhase =
	| "scope_before"
	| "clock_before"
	| "back_to_board"
	| "board_visible"
	| "select_task"
	| "terminal_visible"
	| "clock_after"
	| "scope_after"
	| "unknown";

/** Serialize the same bounded semantic task-navigation flow for the desktop and existing named browser page. */
async function navigatePerformanceTask(
	page: Page,
	scope: { projectId: string; taskId: string },
): Promise<PerformanceNavigationTiming> {
	let phase: PerformanceNavigationPhase = "scope_before";
	try {
		// The SDK supplies the URL object; the wrapper VM has no URL globals. Explicit gates cannot outlive their timeout.
		await page.waitForURL(
			(url) => {
				if (
					decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "") !== scope.projectId ||
					url.searchParams.get("task") !== scope.taskId
				)
					throw new Error("Performance navigation lost its original selected task.");
				return true;
			},
			{ timeout: 5_000, waitUntil: "commit" },
		);
		phase = "clock_before";
		// The wrapper VM has no performance global. Read the same clock through the SDK in either client.
		const startedHandle = await page.waitForFunction(
			() => {
				const viewport = globalThis as unknown as { innerWidth: number; innerHeight: number };
				return {
					now: performance.now(),
					origin: performance.timeOrigin,
					width: viewport.innerWidth,
					height: viewport.innerHeight,
				};
			},
			undefined,
			{ timeout: 5_000 },
		);
		const started = await startedHandle.jsonValue().finally(() => startedHandle.dispose());
		if (!Number.isFinite(started.now) || !Number.isFinite(started.origin) || started.now < 0)
			throw new Error("Invalid navigation start clock.");
		phase = "back_to_board";
		await page.getByRole("button", { name: "Back to board", exact: true }).click({ timeout: 5_000 });
		phase = "board_visible";
		await page.locator("section.kb-board").waitFor({ state: "visible", timeout: 5_000 });
		phase = "select_task";
		await page
			.locator(`[data-task-id=${JSON.stringify(scope.taskId)}]`)
			.first()
			.click({ timeout: 5_000 });
		phase = "terminal_visible";
		await page.getByRole("textbox", { name: "Terminal input" }).waitFor({ state: "visible", timeout: 5_000 });
		phase = "clock_after";
		const finishedHandle = await page.waitForFunction(
			() => {
				const viewport = globalThis as unknown as { innerWidth: number; innerHeight: number };
				return {
					now: performance.now(),
					origin: performance.timeOrigin,
					width: viewport.innerWidth,
					height: viewport.innerHeight,
				};
			},
			undefined,
			{ timeout: 5_000 },
		);
		const finished = await finishedHandle.jsonValue().finally(() => finishedHandle.dispose());
		if (
			!Number.isFinite(finished.now) ||
			finished.now < started.now ||
			finished.origin !== started.origin ||
			finished.width !== started.width ||
			finished.height !== started.height
		)
			throw new Error("Navigation clock or viewport changed.");
		phase = "scope_after";
		await page.waitForURL(
			(url) => {
				if (
					decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "") !== scope.projectId ||
					url.searchParams.get("task") !== scope.taskId
				)
					throw new Error("Performance navigation selected a different task.");
				return true;
			},
			{ timeout: 5_000, waitUntil: "commit" },
		);
		return {
			boundary: "ui-action-to-terminal-visible",
			clock: "renderer-monotonic",
			durationMs: finished.now - started.now,
			viewport: { width: started.width, height: started.height },
		};
	} catch {
		throw new Error(`Performance navigation failed at ${phase}.`);
	}
}

/** The wrapper VM returns bounded timing metadata or a fixed phase, never underlying exceptions or output. */
function performanceNavigationScript(scope: { projectId: string; taskId: string }): string {
	return `async page => {
		try { return {outcome:'acknowledged',timing:await (${navigatePerformanceTask.toString()})(page,${JSON.stringify(scope)})}; }
		catch (error) { const match = /^Performance navigation failed at (scope_before|clock_before|back_to_board|board_visible|select_task|terminal_visible|clock_after|scope_after)\\.$/.exec(error.message); return {outcome:'failed',phase:match ? match[1] : 'unknown'}; }
	}`;
}

function readPerformanceNavigationResult(
	raw: unknown,
): { phase: null; timing: PerformanceNavigationTiming } | { phase: PerformanceNavigationPhase; timing: null } {
	if (raw && typeof raw === "object") {
		if (Reflect.get(raw, "outcome") === "acknowledged") {
			try {
				return { phase: null, timing: parsePerformanceNavigationTiming(Reflect.get(raw, "timing")) };
			} catch {
				return { phase: "unknown", timing: null };
			}
		}
		if (Reflect.get(raw, "outcome") === "failed") {
			const phase = (
				[
					"scope_before",
					"clock_before",
					"back_to_board",
					"board_visible",
					"select_task",
					"terminal_visible",
					"clock_after",
					"scope_after",
				] as const
			).find((phase) => phase === Reflect.get(raw, "phase"));
			return { phase: phase ?? "unknown", timing: null };
		}
	}
	return { phase: "unknown", timing: null };
}

/** Executed in either isolated renderer; contains no Node or desktop bridge dependency. */
async function readClient({ projectId, taskId }: { projectId: string; taskId: string }) {
	const browser = globalThis as unknown as {
		document: { querySelector: (selector: string) => unknown };
		CSS: { escape: (value: string) => string };
		location: { pathname: string; search: string };
	};
	if (
		decodeURIComponent(browser.location.pathname.split("/").filter(Boolean)[0] ?? "") !== projectId ||
		new URLSearchParams(browser.location.search).get("task") !== taskId
	)
		throw new Error("Coexistence client selected a different project or task.");
	const response = await fetch("/api/trpc/project.getState", {
		headers: { "x-quarterdeck-project-id": projectId },
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error("Coexistence project query failed.");
	const text = await response.text();
	if (text.length > 2 * 1024 * 1024) throw new Error("Coexistence project response exceeds its bound.");
	const body: unknown = JSON.parse(text);
	if (!body || typeof body !== "object") throw new Error("Malformed coexistence project response.");
	const result: unknown = Reflect.get(body, "result");
	if (!result || typeof result !== "object") throw new Error("Missing coexistence project result.");
	const dump: unknown = Reflect.get(globalThis, "__quarterdeckDumpTerminalState");
	if (typeof dump !== "function") throw new Error("Coexistence terminal observation unavailable.");
	const snapshot: unknown = dump();
	if (!snapshot || typeof snapshot !== "object") throw new Error("Missing coexistence terminal snapshot.");
	const slots: unknown = Reflect.get(snapshot, "poolSlots");
	const slot: unknown = Array.isArray(slots)
		? slots.find(
				(entry: unknown) =>
					entry !== null &&
					typeof entry === "object" &&
					Reflect.get(entry, "taskId") === taskId &&
					Reflect.get(entry, "projectId") === projectId,
			)
		: null;
	const buffer: unknown = slot && typeof slot === "object" ? Reflect.get(slot, "buffer") : null;
	const viewportRows: unknown = buffer && typeof buffer === "object" ? Reflect.get(buffer, "viewportRows") : null;
	if (
		typeof viewportRows !== "number" ||
		viewportRows <= 0 ||
		!browser.document.querySelector(".xterm-screen") ||
		!browser.document.querySelector(`[data-task-id="${browser.CSS.escape(taskId)}"]`)
	)
		throw new Error("Coexistence client did not display the selected task terminal.");
	return { state: Reflect.get(result, "data") as unknown, viewportRows };
}

function projectClient(raw: unknown, taskId: string): DesktopBrowserClientEvidence {
	if (!raw || typeof raw !== "object") throw new Error("Missing coexistence client result.");
	const state = runtimeProjectStateResponseSchema.parse(Reflect.get(raw, "state"));
	const viewportRows: unknown = Reflect.get(raw, "viewportRows");
	const session = state.sessions[taskId];
	const column = state.board.columns.find((entry) => entry.cards.some((card) => card.id === taskId));
	if (
		!session ||
		!column ||
		!session.sessionInstanceId ||
		!session.resumeSessionId ||
		!session.pid ||
		typeof viewportRows !== "number"
	)
		throw new Error("Coexistence lacks the existing managed task.");
	return {
		revision: state.revision,
		boardDigest: createHash("sha256").update(JSON.stringify(state.board)).digest("hex"),
		taskId,
		columnId: column.id,
		sessionInstanceId: session.sessionInstanceId,
		providerSessionId: session.resumeSessionId,
		pid: session.pid,
		state: session.state,
		viewportRows,
	};
}

function parseWrapperResult(stdout: string): unknown {
	const result = /^### Result\r?\n([\s\S]*?)(?=\r?\n### |$)/mu.exec(stdout)?.[1];
	if (!result || result.length > 256 * 1024)
		throw new Error("Browser wrapper returned no bounded coexistence result.");
	return JSON.parse(result.trim()) as unknown;
}

/** Joins the existing fake desktop runtime; never starts a task, runtime, or another fixture. */
export async function exerciseDesktopBrowserCoexistence(
	page: Page,
	fixture: DesktopLabFixture,
	taskId: string,
	options: {
		resizeDesktop: (width: number, height: number) => Promise<void>;
		performance?: { readAdmittedDesktop: DesktopPerformanceScenarioScope["readAdmittedDesktop"] };
	},
) {
	const config = readLabLaunchConfig(fixture.configPath);
	if (
		fixture.manifest.agent.mode !== "fake" ||
		config.stateHome !== fixture.config.stateHome ||
		config.tempRoot !== fixture.config.tempRoot ||
		fixture.environment.QUARTERDECK_DESKTOP_LAB_CONFIG !== fixture.configPath ||
		fixture.environment.QUARTERDECK_STATE_HOME !== config.stateHome
	)
		throw new Error("Browser coexistence requires the current isolated fake desktop fixture.");
	const desktopUrl = new URL(page.url());
	const projectId = decodeURIComponent(desktopUrl.pathname.split("/").filter(Boolean)[0] ?? "");
	if (
		desktopUrl.protocol !== "app:" ||
		desktopUrl.hostname !== "quarterdeck" ||
		!projectId ||
		desktopUrl.searchParams.get("task") !== taskId
	)
		throw new Error("Browser coexistence requires the selected desktop fixture task.");
	const control = await mkdtemp(join(config.tempRoot, ".desktop-browser-"));
	const session = `qd-desktop-browser-${fixture.manifest.runId}`;
	const browserConfig = join(fixture.manifest.artifactDir, "playwright-cli.config.json");
	let commandUnconfirmed = false;
	const run = async (args: string[], silent = false): Promise<string> => {
		try {
			const stdout = await runBoundedBrowserCommand(() =>
				spawn(
					process.execPath,
					["--import", "tsx", join(AGENT_LAB_REPO_ROOT, "scripts", "agent-browser.ts"), `-s=${session}`, ...args],
					{ cwd: AGENT_LAB_REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
				),
			);
			return silent ? "" : stdout;
		} catch (error) {
			if (error instanceof DesktopBrowserWrapperCommandUnconfirmedError) commandUnconfirmed = true;
			throw new Error("Desktop/browser wrapper command failed; private output withheld.");
		}
	};
	const runCode = async (name: string, code: string, silent = false) => {
		const path = join(control, `${name}.js`);
		await writeFile(path, code, { mode: 0o600 });
		return run(["run-code", `--filename=${path}`], silent);
	};
	const scope = { projectId, taskId };
	try {
		const ports: DesktopBrowserCoexistencePorts = {
			readOwner: async () => {
				const evidence = DesktopProcessEvidenceSchema.parse(
					JSON.parse(await readFile(config.processEvidencePath, "utf8")) as unknown,
				);
				const owner = await discoverRuntimeOwner(config.stateHome);
				if (
					owner?.descriptor?.status !== "ready" ||
					owner.processState !== "live" ||
					owner.released ||
					owner.claim.generation !== evidence.generation ||
					owner.claim.process.pid !== evidence.helperPid ||
					evidence.helperPid !== fixture.manifest.helperPid
				)
					throw new Error("Desktop/browser owner identity is unverified.");
				const origin = await verifyRuntimeOwner(owner.descriptor, false);
				if (origin !== evidence.runtimeOrigin) throw new Error("Desktop/browser owner endpoint changed.");
				return { ...owner.claim.process, generation: owner.claim.generation, origin };
			},
			readDesktop: async () => projectClient(await page.evaluate(readClient, scope), taskId),
			openBrowser: async () => {
				await run(["--config", browserConfig, "open", "about:blank"], true);
				const evidence = DesktopProcessEvidenceSchema.parse(
					JSON.parse(await readFile(config.processEvidencePath, "utf8")) as unknown,
				);
				if (!evidence.runtimeOrigin || !evidence.helperPid)
					throw new Error("Missing desktop owner bootstrap identity.");
				await withLabBrowserAdmissionScript(
					{
						statePath: config.stateHome,
						runtimeUrl: evidence.runtimeOrigin,
						webUrl: evidence.runtimeOrigin,
						processes: {
							runtime: {
								pid: evidence.helperPid,
								logPath: join(fixture.manifest.artifactDir, "runtime.log"),
							},
							web: null,
						},
						tempRoot: config.tempRoot,
					},
					async (scriptPath) => {
						await run(["run-code", `--filename=${scriptPath}`], true);
					},
				);
				await runCode(
					"navigate",
					`async page => {
					page.__qdCoexistenceSockets = [];
					page.on('websocket', socket => { const address = socket.url(); const path = address.slice(address.indexOf('/',address.indexOf('://')+3)).split('?')[0]; if (!['/api/runtime/ws','/api/terminal/io','/api/terminal/control'].includes(path) || page.__qdCoexistenceSockets.length >= 32) return; const row = {path, received:0}; page.__qdCoexistenceSockets.push(row); socket.on('framereceived', () => row.received++); });
					await page.goto(${JSON.stringify(evidence.runtimeOrigin)});
					const onboarding = page.getByRole('dialog',{name:'Get started'}); if(await onboarding.isVisible()) await page.keyboard.press('Escape');
					await page.getByRole('button',{name:'Home',exact:true}).click();
					await page.getByRole('button',{name:'Open project',exact:true}).click();
					await page.locator('section.kb-board').waitFor({state:'visible'});
					await page.locator('[data-task-id='+${JSON.stringify(JSON.stringify(taskId))}+']').first().click();
					await page.getByRole('textbox',{name:'Terminal input'}).waitFor({state:'visible'});
				}`,
					true,
				);
			},
			readBrowser: async () => {
				const output = await runCode(
					"observe",
					`async page => {
					await page.waitForFunction(scope => window.__quarterdeckDumpTerminalState?.().poolSlots.some(slot => slot.taskId === scope.taskId && slot.projectId === scope.projectId && slot.buffer.viewportRows > 0), ${JSON.stringify(scope)}, {timeout:15000});
					for(let attempt=0;attempt<30;attempt++){ if(['/api/runtime/ws','/api/terminal/io','/api/terminal/control'].every(path => page.__qdCoexistenceSockets.some(row => row.path === path && row.received > 0))) break; await page.waitForTimeout(100); }
					if (!['/api/runtime/ws','/api/terminal/io','/api/terminal/control'].every(path => page.__qdCoexistenceSockets.some(row => row.path === path && row.received > 0))) throw new Error('Browser coexistence has no transport traffic');
					return await page.evaluate(${readClient.toString()}, ${JSON.stringify(scope)});
				}`,
				);
				return projectClient(parseWrapperResult(output), taskId);
			},
			resize: async (width, height) => {
				await options.resizeDesktop(width, height);
				await run(["resize", String(width), String(height)], true);
				await page.waitForTimeout(250);
			},
			closeBrowser: async () => {
				await closeAgentLabBrowserSession(AGENT_LAB_REPO_ROOT, session, { mode: "named-session-only" });
				if (commandUnconfirmed) throw new DesktopBrowserWrapperCommandUnconfirmedError();
			},
		};
		if (options.performance) {
			const admission = options.performance.readAdmittedDesktop;
			const baselineOwner = await ports.readOwner();
			const baselineClient = await ports.readDesktop();
			ports.measurePerformance = () =>
				recordPerformanceEvidence(
					async () => {
						if (!fixture.manifest.mainPid || !fixture.manifest.helperPid)
							throw new Error("Performance measurement requires captured desktop main/helper identities.");
						// Native setSize includes its title bar. Equalize the already admitted browser after coexistence proof.
						const viewport = await withDesktopDeadline(
							page.evaluate(() => {
								const viewport = globalThis as unknown as { innerWidth: number; innerHeight: number };
								return { width: viewport.innerWidth, height: viewport.innerHeight };
							}),
							"Performance viewport read",
							5_000,
						);
						if (
							!Object.values(viewport).every((value) => Number.isInteger(value) && value >= 1 && value <= 8_192)
						)
							throw new Error("Invalid performance renderer viewport.");
						await run(["resize", String(viewport.width), String(viewport.height)], true);
						return exerciseDesktopPerformanceScenario(
							{
								runId: fixture.manifest.runId,
								repoRoot: AGENT_LAB_REPO_ROOT,
								browserSession: session,
								projectId,
								taskId,
								desktopMainPid: fixture.manifest.mainPid,
								runtimeHelperPid: fixture.manifest.helperPid,
								readAdmittedDesktop: () =>
									withDesktopDeadline(Promise.resolve().then(admission), "Performance admission", 25_000),
								conditions: { desktopVisible: fixture.config.showWindow ?? false, browserHeadless: true },
							},
							{
								progress: { mode: "unavailable", reason: "production-terminal-content-disabled" },
								navigate: async (client) => {
									if (client === "desktop") return navigatePerformanceTask(page, scope);
									else {
										const output = await runCode(
											"performance-navigation",
											performanceNavigationScript(scope),
										);
										const { phase, timing } = readPerformanceNavigationResult(parseWrapperResult(output));
										if (phase) {
											await writeJsonAtomic(
												join(fixture.manifest.artifactDir, "browser-performance-navigation-failure.json"),
												{
													client: "browser",
													phase,
												},
											);
											throw new Error(`Performance browser navigation failed at ${phase}.`);
										}
										return timing;
									}
								},
								verifyScope: async () => {
									const results = await Promise.allSettled([
										withDesktopDeadline(ports.readOwner(), "Performance owner read", 10_000),
										withDesktopDeadline(ports.readDesktop(), "Performance desktop read", 10_000),
										ports.readBrowser(),
									]);
									const [owner, desktop, browser] = results;
									if (
										owner?.status !== "fulfilled" ||
										desktop?.status !== "fulfilled" ||
										browser?.status !== "fulfilled"
									)
										throw new Error("Performance scope reads are incomplete.");
									assertOwner(baselineOwner, owner.value);
									assertClient(baselineClient, desktop.value);
									assertClient(baselineClient, browser.value);
								},
							},
						);
					},
					(evidence) =>
						writeJsonAtomic(join(fixture.manifest.artifactDir, "desktop-browser-performance.json"), evidence),
				);
		}
		return await proveCoexistence(session, ports);
	} finally {
		await rm(control, { recursive: true, force: true });
	}
}

export const _testing = {
	proveCoexistence,
	parseWrapperResult,
	runBoundedBrowserCommand,
	recordPerformanceEvidence,
	navigatePerformanceTask,
	performanceNavigationScript,
	readPerformanceNavigationResult,
};
