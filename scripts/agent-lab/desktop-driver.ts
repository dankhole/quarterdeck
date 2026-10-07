import { randomUUID } from "node:crypto";
import { appendFile, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	_electron,
	type Browser,
	type ConsoleMessage,
	type ElectronApplication,
	type Page,
	type Request,
	type Response,
} from "playwright-core";
import { isFileSystemPathWithin } from "../../src/core/path-comparison.js";
import { setDesktopTreeWritable } from "../../src/desktop-install/files.js";
import { DESKTOP_LAUNCH_ARGUMENT, serializeDesktopLaunchRequest } from "../../src/shared/desktop-launch-contract.js";
import { DesktopConfigObserver } from "./desktop-config-evidence";
import type { DesktopEvaluationModule, DesktopReobserveEvaluationModule } from "./desktop-evaluation-types";
import type { DesktopLabFixture } from "./desktop-fixture";
import { DesktopMainLossError, type DesktopMainLossProof } from "./desktop-main-loss";
import {
	collectOwnedDesktopProcesses,
	findMarkedDesktopProcesses,
	listDesktopProcesses,
	sameDesktopProcess,
	stopOwnedDesktopProcesses,
} from "./desktop-processes";
import { removeDesktopProviderProfiles } from "./desktop-provider";
import { type DesktopDebugEndpoint, observeDesktopRenderer, readDesktopDebugEndpoint } from "./desktop-reobserve";
import {
	DesktopSecondLaunchError,
	type DesktopSecondLaunchOptions,
	type DesktopSecondLaunchProof,
	proveDesktopSecondLaunch,
} from "./desktop-second-launch";
import { captureDesktopShutdownEvidence } from "./desktop-shutdown-evidence";
import { DesktopSocketObserver } from "./desktop-sockets";
import { type DesktopLabProcess, type DesktopLabShutdownEvidence, DesktopProcessEvidenceSchema } from "./desktop-types";
import { writeJsonAtomic } from "./paths";

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withDesktopDeadline<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export class DesktopLabDriver {
	readonly sockets = new DesktopSocketObserver();
	readonly configEvidence = new DesktopConfigObserver();
	private application: ElectronApplication | null = null;
	private launchPromise: Promise<Page> | null = null;
	private stopPromise: Promise<void> | null = null;
	private knownProcesses: DesktopLabProcess[] = [];
	private stopped = false;
	private logWrites: Promise<void> = Promise.resolve();
	private trackingTimer: ReturnType<typeof setInterval> | null = null;
	private tracking: Promise<void> = Promise.resolve();
	private logSizes = new Map<string, number>();
	private debugEndpoint: DesktopDebugEndpoint | null = null;
	private originalMain: DesktopLabProcess | null = null;
	private rendererObserver: Browser | null = null;
	private observedPage: Page | null = null;
	private rendererObservation: Promise<Page> | null = null;
	private captures = new Set<Promise<unknown>>();
	private retirementPromise: Promise<DesktopLabFixture> | null = null;
	private mainLossObservation: Promise<DesktopMainLossProof> | null = null;
	private retired = false;
	private retirementCancelled = false;
	private applicationClosed: Promise<void> | null = null;
	private listenerRemovers: Array<() => void> = [];
	private logsClosed = false;
	private preparingFixture = false;
	private fixturePreparation: Promise<unknown> | null = null;
	private secondaryLaunches = new Set<Promise<DesktopSecondLaunchProof>>();

	constructor(readonly fixture: DesktopLabFixture) {}

	private log(name: string, value: string): void {
		if (this.logsClosed) return;
		// Serialize bounded synthetic log writes; cleanup awaits their completion.
		const previousSize = this.logSizes.get(name) ?? 0;
		const bounded = value.slice(0, Math.max(0, 256_000 - previousSize));
		if (!bounded) return;
		this.logSizes.set(name, previousSize + bounded.length);
		this.logWrites = this.logWrites.then(() => appendFile(join(this.fixture.manifest.artifactDir, name), bounded));
		void this.logWrites.catch(() => {});
	}

	private capture<T>(operation: () => Promise<T>): Promise<T> {
		const pending = operation();
		this.captures.add(pending);
		void pending.then(
			() => this.captures.delete(pending),
			() => this.captures.delete(pending),
		);
		return pending;
	}

	private assertActive(): void {
		if (this.stopped) throw new Error("Desktop driver is no longer accepting observations.");
	}

	private observePageLogs(page: Page): void {
		const consoleMessage = (message: ConsoleMessage) =>
			this.log("renderer-console.log", `${message.type()}: ${message.text()}\n`);
		const pageError = (error: Error) => this.log("renderer-errors.log", `${error.message}\n`);
		const response = (value: Response) => {
			const path = new URL(value.url()).pathname;
			if (path.startsWith("/api/") || value.status() >= 400)
				this.log("renderer-network.log", `${value.status()} ${path}\n`);
		};
		const requestFailed = (request: Request) =>
			this.log("renderer-network.log", `failed ${request.method()} ${new URL(request.url()).pathname}\n`);
		page.on("console", consoleMessage);
		page.on("pageerror", pageError);
		page.on("response", response);
		page.on("requestfailed", requestFailed);
		this.listenerRemovers.push(() => {
			page.off("console", consoleMessage);
			page.off("pageerror", pageError);
			page.off("response", response);
			page.off("requestfailed", requestFailed);
		});
	}

	launch(): Promise<Page> {
		if (this.launchPromise || this.stopped || this.preparingFixture)
			return Promise.reject(new Error("Desktop driver can launch only once after fixture preparation settles."));
		this.launchPromise = this.launchApplication();
		return this.launchPromise;
	}

	/** Keep private installer writes admitted until shutdown may safely remove their fixture. */
	prepareFixture<T>(operation: () => Promise<T>): Promise<T> {
		this.assertActive();
		if (this.launchPromise || this.preparingFixture)
			return Promise.reject(new Error("Desktop fixture preparation must precede launch."));
		this.preparingFixture = true;
		const pending = Promise.resolve().then(async () => {
			try {
				this.assertActive();
				const result = await operation();
				this.assertActive();
				return result;
			} finally {
				this.preparingFixture = false;
			}
		});
		this.fixturePreparation = pending;
		return pending;
	}

	/** Retain exact secondary launch custody through shutdown and prohibit post-stop spawn. */
	proveSecondLaunch(options: DesktopSecondLaunchOptions): Promise<DesktopSecondLaunchProof> {
		this.assertActive();
		const pending = Promise.resolve().then(async () => {
			try {
				this.assertActive();
				return await proveDesktopSecondLaunch(this.fixture, {
					...options,
					assertLaunchAllowed: () => this.assertActive(),
				});
			} catch (error) {
				if (error instanceof DesktopSecondLaunchError && !error.cleanupConfirmed)
					this.retainSecondaryLaunchProcesses(error.secondProcesses, options.selectedApplication?.appPath);
				throw error;
			}
		});
		this.secondaryLaunches.add(pending);
		void pending.then(
			() => this.secondaryLaunches.delete(pending),
			() => this.secondaryLaunches.delete(pending),
		);
		return pending;
	}

	private async launchApplication(): Promise<Page> {
		const fixture = this.fixture;
		this.assertActive();
		// Custody and cleanup require process inspection. A restricted host sandbox
		// can also abort AppKit registration, producing a macOS crash dialog before
		// Playwright admits the application. Refuse that environment before spawn.
		try {
			await listDesktopProcesses();
		} catch {
			throw new Error(
				"Desktop Agent Lab cannot inspect native processes. Run the isolated test with native application, local socket, and process-inspection permission; no app was launched.",
			);
		}
		this.assertActive();
		this.application = await _electron.launch({
			executablePath: fixture.manifest.executablePath,
			cwd: fixture.config.projectPath,
			env: fixture.environment,
			// Synthetic lab only: avoid touching or prompting for the user's Keychain.
			args: [
				"--use-mock-keychain",
				`--user-data-dir=${fixture.config.userDataPath}`,
				...(fixture.launchRequest
					? [DESKTOP_LAUNCH_ARGUMENT, serializeDesktopLaunchRequest(fixture.launchRequest)]
					: []),
			],
			timeout: 45_000,
			chromiumSandbox: true,
			artifactsDir: fixture.manifest.artifactDir,
		});
		const application = this.application;
		this.applicationClosed = new Promise((resolve) => application.once("close", () => resolve()));
		const child = application.process();
		fixture.manifest.mainPid = child.pid ?? null;
		const stdout = (chunk: Buffer) => this.log("electron.stdout.log", chunk.toString());
		const stderr = (chunk: Buffer) => this.log("electron.stderr.log", chunk.toString());
		child.stdout?.on("data", stdout);
		child.stderr?.on("data", stderr);
		this.listenerRemovers.push(() => {
			child.stdout?.off("data", stdout);
			child.stderr?.off("data", stderr);
		});
		if (this.stopped) throw new Error("Desktop launch was cancelled; stopping the owned application.");
		const context = this.application.context();
		const observePage = (page: Page) => {
			if (this.stopped) return;
			this.sockets.observe(page);
			this.configEvidence.observe(page);
		};
		context.on("page", observePage);
		this.listenerRemovers.push(() => context.off("page", observePage));
		for (const page of this.application.windows()) {
			this.sockets.observe(page);
			this.configEvidence.observe(page);
		}
		await this.trackProcesses();
		this.originalMain = this.knownProcesses.find((entry) => entry.pid === child.pid) ?? null;
		if (this.originalMain) this.debugEndpoint = await readDesktopDebugEndpoint(fixture.config.userDataPath);
		this.trackingTimer = setInterval(() => {
			if (this.stopped) return;
			this.tracking = this.tracking
				.then(() => (this.stopped ? undefined : this.trackProcesses()))
				.catch((error: unknown) => {
					this.log("tracking-errors.log", `${error instanceof Error ? error.message : String(error)}\n`);
				});
		}, 500);
		const page = await this.application.firstWindow({ timeout: 45_000 });
		this.observePageLogs(page);
		page.setDefaultTimeout(20_000);
		await this.application.context().addInitScript(() => {
			try {
				localStorage.setItem("quarterdeck.onboarding.dialog.shown", "true");
				localStorage.setItem("quarterdeck.onboarding.tips.dismissed", "true");
			} catch {
				// The startup document may not have storage yet.
			}
		});
		return page;
	}

	get app(): ElectronApplication {
		if (!this.application) throw new Error("Desktop application has not launched.");
		return this.application;
	}

	rendererPages(): Page[] {
		if (this.observedPage) return [this.observedPage];
		return this.rendererObservation ? [] : this.app.windows();
	}

	reobserveAfterRendererCrash(windowId: number): Promise<Page> {
		this.assertActive();
		if (this.rendererObservation)
			return Promise.reject(new Error("Desktop renderer observation can start only once."));
		this.rendererObservation = this.observeAfterRendererCrash(windowId);
		return this.rendererObservation;
	}

	private async observeAfterRendererCrash(windowId: number): Promise<Page> {
		if (this.stopped || this.rendererObserver || !this.originalMain || !this.debugEndpoint)
			throw new Error("Desktop renderer observation requires its original live launch.");
		const originalMain = this.originalMain;
		const capture = async () => {
			const currentMain = (await listDesktopProcesses()).find((entry) => entry.pid === originalMain.pid);
			if (!currentMain || !sameDesktopProcess(originalMain, currentMain))
				throw new Error("Desktop renderer observation lost its original main process.");
			const state = await withDesktopDeadline(
				this.app.evaluate(({ app, BrowserWindow }: DesktopReobserveEvaluationModule, id) => {
					const windows = BrowserWindow.getAllWindows();
					const window = windows.find((entry) => entry.id === id);
					if (windows.length !== 1 || !window || !window.webContents.getURL().startsWith("app://quarterdeck/"))
						throw new Error("Desktop renderer observation requires its exact private window.");
					return {
						mainPid: process.pid,
						packaged: app.isPackaged,
						appPath: app.getAppPath(),
						userDataPath: app.getPath("userData"),
						windowId: window.id,
						webContentsId: window.webContents.id,
						rendererPid: window.webContents.getOSProcessId(),
						url: window.webContents.getURL(),
					};
				}, windowId),
				"Desktop observer ownership",
				5_000,
			);
			if (
				state.mainPid !== originalMain.pid ||
				!state.packaged ||
				state.appPath !== join(this.fixture.manifest.appPath, "Contents", "Resources", "app.asar") ||
				state.userDataPath !== this.fixture.config.userDataPath
			)
				throw new Error("Desktop renderer observation found another application fixture.");
			return state;
		};
		let before = await capture();
		const deadline = Date.now() + 15_000;
		while (before.url !== "app://quarterdeck/__desktop/error" || before.rendererPid <= 0) {
			if (Date.now() >= deadline)
				throw new Error("Desktop renderer error document did not become ready for observation.");
			await wait(100);
			before = await capture();
		}
		const nonce = randomUUID();
		await withDesktopDeadline(
			this.app.evaluate(
				async ({ BrowserWindow }: DesktopReobserveEvaluationModule, binding) => {
					const window = BrowserWindow.getAllWindows().find((entry) => entry.id === binding.windowId);
					if (
						!window ||
						window.webContents.id !== binding.webContentsId ||
						window.webContents.getURL() !== binding.url ||
						window.webContents.getOSProcessId() !== binding.rendererPid
					)
						throw new Error("Desktop renderer document changed before observation binding.");
					await window.webContents.executeJavaScript(
						`globalThis.__quarterdeckDesktopLabReobserveNonce = ${JSON.stringify(binding.nonce)}`,
					);
				},
				{ ...before, nonce },
			),
			"Desktop observer document binding",
			5_000,
		);
		const observation = await observeDesktopRenderer({
			capturedEndpoint: this.debugEndpoint,
			artifactDir: this.fixture.manifest.artifactDir,
			nonce,
			assertOriginalOwner: async () => {
				const current = await capture();
				if (
					current.windowId !== before.windowId ||
					current.webContentsId !== before.webContentsId ||
					current.rendererPid !== before.rendererPid ||
					current.url !== before.url
				)
					throw new Error("Desktop renderer changed during observation.");
			},
			registerObserver: (browser) => {
				this.rendererObserver = browser;
			},
		});
		this.observedPage = observation.page;
		this.sockets.observe(observation.page);
		this.configEvidence.observe(observation.page);
		this.observePageLogs(observation.page);
		await writeJsonAtomic(join(this.fixture.manifest.artifactDir, "renderer-reobserve.json"), {
			...before,
			originalMainBirth: originalMain.startedAt,
			sameWebContents: true,
			nonceBound: true,
			noDefaults: true,
		});
		return observation.page;
	}

	async observeSecondInstances(): Promise<() => Promise<number>> {
		await this.app.evaluate(({ app }: DesktopEvaluationModule) => {
			if (app.__quarterdeckLabSecondInstanceCount !== undefined) return;
			app.__quarterdeckLabSecondInstanceCount = 0;
			app.on("second-instance", () => {
				app.__quarterdeckLabSecondInstanceCount = (app.__quarterdeckLabSecondInstanceCount ?? 0) + 1;
			});
		});
		return () =>
			this.app.evaluate(({ app }: DesktopEvaluationModule) => app.__quarterdeckLabSecondInstanceCount ?? 0);
	}

	async resizeOwnedWindow(width: number, height: number): Promise<void> {
		if (
			!Number.isInteger(width) ||
			!Number.isInteger(height) ||
			width < 760 ||
			height < 540 ||
			width > 1920 ||
			height > 1280
		)
			throw new Error("Desktop lab resize is outside its bounded viewport range.");
		await this.app.evaluate(
			({ BrowserWindow }: DesktopEvaluationModule, size) => {
				const windows = BrowserWindow.getAllWindows();
				const window = windows[0];
				if (windows.length !== 1 || !window?.webContents.getURL().startsWith("app://quarterdeck/"))
					throw new Error("Desktop lab cannot resize a window outside its isolated product surface.");
				window.setSize(size.width, size.height);
			},
			{ width, height },
		);
	}

	retainSecondaryLaunchProcesses(
		captured: readonly DesktopLabProcess[],
		selectedAppPath = this.fixture.manifest.appPath,
	): void {
		if (captured.length === 0) return;
		if (
			selectedAppPath !== this.fixture.manifest.appPath &&
			!isFileSystemPathWithin(this.fixture.config.tempRoot, selectedAppPath)
		)
			throw new Error("Secondary launch cleanup refused an application outside its isolated fixture.");
		const processes = [...captured];
		const roots = findMarkedDesktopProcesses(
			processes,
			selectedAppPath,
			this.fixture.config.userDataPath,
			this.fixture.config.hostSimulationConfigPath,
		);
		const admitted = collectOwnedDesktopProcesses(processes, roots);
		if (
			admitted.length !== processes.length ||
			processes.some(
				(process) =>
					process.pid === this.fixture.manifest.mainPid || process.pid === this.fixture.manifest.helperPid,
			)
		)
			throw new Error("Secondary launch cleanup refused identities outside its isolated process tree.");
		this.knownProcesses = [
			...new Map([...this.knownProcesses, ...admitted].map((process) => [process.pid, process])).values(),
		];
	}

	private trackProcesses(): Promise<void> {
		return this.capture(() => this.captureProcesses());
	}

	private async captureProcesses(): Promise<void> {
		const evidence = DesktopProcessEvidenceSchema.parse(
			JSON.parse(await readFile(this.fixture.config.processEvidencePath, "utf8")) as unknown,
		);
		const processes = await listDesktopProcesses();
		const mainPid = this.fixture.manifest.mainPid;
		const marked = findMarkedDesktopProcesses(
			processes,
			this.fixture.manifest.appPath,
			this.fixture.config.userDataPath,
			this.fixture.config.hostSimulationConfigPath,
		);
		// The SDK PID is an expected identity, not cleanup authority: before our
		// first capture it may already belong to another process after PID reuse.
		const current = collectOwnedDesktopProcesses(processes, marked, this.knownProcesses);
		this.knownProcesses = [
			...new Map([...this.knownProcesses, ...current].map((process) => [process.pid, process])).values(),
		];
		this.fixture.manifest.processes = this.knownProcesses;
		this.fixture.manifest.rendererPids = current
			.filter((process) => process.command.includes("--type=renderer"))
			.map((process) => process.pid);
		if (evidence.appPid !== undefined && mainPid !== null && evidence.appPid !== mainPid) {
			throw new Error("Desktop process evidence identifies another application process.");
		}
		if (evidence.helperPid !== null) {
			if (
				processes.some((process) => process.pid === evidence.helperPid) &&
				!current.some((process) => process.pid === evidence.helperPid) &&
				evidence.phase !== "stopped" &&
				evidence.phase !== "failed"
			) {
				throw new Error("Desktop helper evidence does not identify a launched application descendant.");
			}
		}
		this.fixture.manifest.helperPid = current.some((process) => process.pid === evidence.helperPid)
			? evidence.helperPid
			: null;
		await writeJsonAtomic(this.fixture.manifestPath, this.fixture.manifest);
	}

	inspect(label: string): Promise<void> {
		this.assertActive();
		return this.capture(() => this.captureInspection(label));
	}

	private async captureInspection(label: string): Promise<void> {
		if (!/^[a-z][a-z0-9-]{0,50}$/u.test(label)) throw new Error("Invalid desktop checkpoint label.");
		await this.tracking;
		await this.trackProcesses();
		const windows = await this.app.evaluate(({ BrowserWindow, app }: DesktopEvaluationModule) => ({
			packaged: app.isPackaged,
			appPath: app.getAppPath(),
			userDataPath: app.getPath("userData"),
			windows: BrowserWindow.getAllWindows().map((window) => ({
				id: window.id,
				visible: window.isVisible(),
				focused: window.isFocused(),
				bounds: window.getBounds(),
				url: window.webContents.getURL(),
				rendererPid: window.webContents.getOSProcessId(),
			})),
		}));
		if (!windows.packaged) throw new Error("Desktop Agent Lab must exercise a packaged application.");
		if (windows.userDataPath !== this.fixture.config.userDataPath)
			throw new Error("Desktop used a non-isolated userData directory.");
		await writeJsonAtomic(join(this.fixture.manifest.artifactDir, `${label}.json`), windows);
		await writeJsonAtomic(
			join(this.fixture.manifest.artifactDir, `${label}-agent-availability.json`),
			await this.configEvidence.snapshot(),
		);
		if (!this.fixture.config.showWindow && windows.windows.some((window) => window.visible || window.focused))
			throw new Error("Hidden desktop lab exposed or focused a native window.");
		await writeJsonAtomic(join(this.fixture.manifest.artifactDir, `${label}-sockets.json`), this.sockets.snapshot());
		await copyFile(
			this.fixture.config.processEvidencePath,
			join(this.fixture.manifest.artifactDir, `${label}-process-evidence.json`),
		);
		for (const [index, page] of this.rendererPages().entries()) {
			await writeFile(
				join(this.fixture.manifest.artifactDir, `${label}-window-${index}.aria.txt`),
				await page.locator("body").ariaSnapshot(),
				"utf8",
			);
		}
	}

	markReady(): Promise<void> {
		this.assertActive();
		return this.capture(() => this.captureReady());
	}

	private async captureReady(): Promise<void> {
		await this.trackProcesses();
		this.assertActive();
		if (!this.fixture.manifest.helperPid)
			throw new Error("Packaged application did not start its owned runtime helper.");
		this.fixture.manifest.status = "ready";
		await writeJsonAtomic(this.fixture.manifestPath, this.fixture.manifest);
	}

	async interruptOwnedHelper(): Promise<void> {
		this.assertActive();
		await this.tracking;
		await this.trackProcesses();
		const helperPid = this.fixture.manifest.helperPid;
		const identity = this.knownProcesses.find((process) => process.pid === helperPid);
		const current = (await listDesktopProcesses()).find((process) => process.pid === helperPid);
		if (!identity || !current || !sameDesktopProcess(identity, current))
			throw new Error("Cannot interrupt an unverified desktop helper.");
		process.kill(current.pid, "SIGTERM");
	}

	async stopOwnedTaskProcess(expected: DesktopLabProcess): Promise<void> {
		this.assertActive();
		await this.tracking;
		await this.trackProcesses();
		const pid = expected.pid;
		const helperPid = this.fixture.manifest.helperPid;
		if (!helperPid || pid === this.fixture.manifest.mainPid || pid === helperPid)
			throw new Error("Task cleanup requires a distinct owned provider process.");
		const identity = this.knownProcesses.find((process) => process.pid === pid);
		const processes = await listDesktopProcesses();
		const current = processes.find((process) => process.pid === pid);
		const helperDescendants = collectOwnedDesktopProcesses(processes, [helperPid]);
		if (
			!identity ||
			!current ||
			!sameDesktopProcess(expected, identity) ||
			!sameDesktopProcess(expected, current) ||
			!helperDescendants.some((process) => process.pid === pid)
		)
			throw new Error("Task cleanup refused an unverified provider process.");
		const remaining = await stopOwnedDesktopProcesses([current]);
		if (remaining.length > 0) throw new Error("Owned provider process did not stop.");
	}

	/** Admit the fixed bounded proof leaf and retain its custody before stop can perform cleanup. */
	observeMainLossProof(
		operation: (signalMain: (pid: number, signal: "SIGKILL") => void) => Promise<DesktopMainLossProof>,
	): Promise<DesktopMainLossProof> {
		this.assertActive();
		if (this.mainLossObservation) return Promise.reject(new Error("Desktop main-loss proof can start only once."));
		this.mainLossObservation = Promise.resolve()
			.then(() => {
				this.assertActive();
				return operation((pid, signal) => {
					// The leaf fresh-matches exact birth/command immediately before this callback.
					// A stop during its preceding asynchronous reads must prevent the signal.
					this.assertActive();
					process.kill(pid, signal);
				});
			})
			.then(
				(proof) => {
					this.retainMainLossProcesses(proof);
					return proof;
				},
				(error: unknown) => {
					if (error instanceof DesktopMainLossError) this.retainMainLossProcesses(error);
					throw error;
				},
			);
		return this.mainLossObservation;
	}

	/** Only the main-loss proof leaf may extend cleanup custody with reparented identities. */
	retainMainLossProcesses(evidence: DesktopMainLossProof | DesktopMainLossError): void {
		if (this.retired) throw new Error("Retired desktop driver cannot acquire process custody.");
		const main = this.originalMain;
		if (!main || !evidence.ownedProcesses.some((entry) => sameDesktopProcess(main, entry)))
			throw new Error("Main-loss cleanup evidence does not contain the captured application identity.");
		// Preserve different birth identities sharing a PID; fresh scans decide which one is still ours.
		this.knownProcesses = [
			...new Map(
				[...this.knownProcesses, ...evidence.ownedProcesses].map((entry) => [
					`${entry.pid}\0${entry.startedAt}\0${entry.command}`,
					{ ...entry },
				]),
			).values(),
		];
		this.fixture.manifest.processes = this.knownProcesses;
	}

	retireAfterMainLoss(proof: DesktopMainLossProof): Promise<DesktopLabFixture> {
		if (this.retirementPromise) return this.retirementPromise;
		if (this.stopPromise || this.stopped) return Promise.reject(new Error("Desktop shutdown already owns cleanup."));
		// This transfer precedes validation, every await, and any failure cleanup.
		this.retainMainLossProcesses(proof);
		this.stopped = true;
		if (this.trackingTimer) clearInterval(this.trackingTimer);
		this.retirementPromise = this.retireApplication(proof);
		return this.retirementPromise;
	}

	private async retireApplication(proof: DesktopMainLossProof): Promise<DesktopLabFixture> {
		try {
			const fixture = this.fixture;
			const identity = {
				runId: fixture.manifest.runId,
				appPath: fixture.manifest.appPath,
				executablePath: fixture.manifest.executablePath,
				configPath: fixture.configPath,
				tempRoot: fixture.config.tempRoot,
				stateHome: fixture.config.stateHome,
				userDataPath: fixture.config.userDataPath,
				projectPath: fixture.config.projectPath,
				hostSimulationConfigPath: fixture.config.hostSimulationConfigPath,
				processEvidencePath: fixture.config.processEvidencePath,
				home: fixture.environment.HOME ?? null,
				codexHome: fixture.environment.CODEX_HOME ?? null,
				fakeAgentScript: fixture.environment.QUARTERDECK_AGENT_LAB_FAKE_AGENT ?? null,
			};
			if (
				!this.originalMain ||
				!sameDesktopProcess(proof.main, this.originalMain) ||
				fixture.manifest.mainPid !== proof.main.pid ||
				fixture.manifest.agent.mode !== "fake" ||
				fixture.manifest.failure !== null ||
				fixture.config.showWindow ||
				fixture.manifest.showWindow ||
				Object.entries(identity).some(
					([key, value]) => proof.fixtureIdentity[key as keyof typeof identity] !== value,
				) ||
				proof.signal !== "SIGKILL" ||
				proof.fallbackUsed ||
				proof.remainingProcesses.length !== 0 ||
				proof.ownershipBefore.generation !== proof.ownershipAfter.generation ||
				proof.ownershipBefore.released ||
				proof.ownershipBefore.processState !== "live" ||
				proof.ownershipBefore.canonicalStateHome !== fixture.config.stateHome ||
				proof.ownershipAfter.canonicalStateHome !== fixture.config.stateHome ||
				proof.ownershipBefore.pid !== proof.helper.pid ||
				proof.ownershipAfter.pid !== proof.helper.pid ||
				proof.ownershipBefore.creationIdentity !== proof.ownershipAfter.creationIdentity ||
				!proof.ownershipAfter.released ||
				proof.ownershipAfter.processState !== "dead"
			)
				throw new Error("Desktop retirement requires its exact released main-loss proof.");

			// Do not propagate the first rejection while siblings can still overwrite the next leg.
			const admitted = [...this.captures, this.tracking, this.launchPromise, this.rendererObservation];
			const settled = await withDesktopDeadline(
				Promise.allSettled(admitted),
				"Desktop main-loss admitted capture drain",
				5_000,
			);
			const failed = settled.find((entry) => entry.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
			if (!this.applicationClosed) throw new Error("Desktop retirement has no SDK close observation.");
			await withDesktopDeadline(this.applicationClosed, "Desktop main-loss SDK close observation", 5_000);
			if (this.rendererObserver) {
				await withDesktopDeadline(this.rendererObserver.close(), "Desktop main-loss observer disconnect", 5_000);
				this.rendererObserver = null;
			}
			this.logsClosed = true;
			const detachErrors: unknown[] = [];
			for (const detach of this.listenerRemovers.splice(0)) {
				try {
					detach();
				} catch (error) {
					detachErrors.push(error);
				}
			}
			const evidenceSettled = await withDesktopDeadline(
				Promise.allSettled([this.configEvidence.snapshot(), this.logWrites]),
				"Desktop main-loss evidence drain",
				5_000,
			);
			const evidenceFailure = evidenceSettled.find((entry) => entry.status === "rejected");
			if (detachErrors.length > 0) throw detachErrors[0];
			if (evidenceFailure?.status === "rejected") throw evidenceFailure.reason;
			const remaining = collectOwnedDesktopProcesses(await listDesktopProcesses(), [], this.knownProcesses);
			if (remaining.length > 0) throw new Error("Desktop retirement still has owned processes.");
			if ((await readFile(fixture.forbiddenHostLaunchLogPath, "utf8")).trim())
				throw new Error("Desktop Agent Lab invoked a forbidden host launcher.");
			if (this.retirementCancelled) throw new Error("Desktop retirement was cancelled by cleanup.");
			const archived = structuredClone(fixture.manifest);
			archived.status = "stopped";
			archived.stoppedAt = new Date().toISOString();
			archived.remainingPids = [];
			// A main crash has no graceful Quit receipt. The archive states that separate proof explicitly.
			await writeJsonAtomic(join(archived.artifactDir, "main-loss-first-manifest.json"), {
				manifest: archived,
				proof,
			});
			const manifest = structuredClone(archived);
			manifest.status = "starting";
			manifest.mainPid = null;
			manifest.helperPid = null;
			manifest.rendererPids = [];
			manifest.processes = [];
			manifest.remainingPids = [];
			manifest.failure = null;
			manifest.stoppedAt = null;
			delete manifest.shutdown;
			const next = { ...fixture, manifest, config: { ...fixture.config }, environment: { ...fixture.environment } };
			await writeJsonAtomic(fixture.config.processEvidencePath, {
				version: 1,
				helperPid: null,
				generation: null,
				runtimeOrigin: null,
				phase: "starting",
			});
			await writeJsonAtomic(fixture.manifestPath, manifest);
			if (this.retirementCancelled) throw new Error("Desktop retirement was cancelled by cleanup.");
			// Commit only after every old writer is settled and the distinct next manifest is durable.
			this.retired = true;
			this.stopPromise = Promise.resolve();
			return next;
		} catch (error) {
			// Until commit this driver still owns exact cleanup; keep recovery artifacts/history on failure.
			this.fixture.keepTemp = true;
			throw error;
		}
	}

	stop(failure?: unknown): Promise<void> {
		if (this.retired) return this.stopPromise ?? Promise.resolve();
		if (!this.stopPromise) {
			if (this.retirementPromise) {
				this.retirementCancelled = true;
				this.stopPromise = this.retirementPromise.catch(() => undefined).then(() => this.stopApplication(failure));
			} else this.stopPromise = this.stopApplication(failure);
		}
		return this.stopPromise;
	}

	private async stopApplication(failure?: unknown): Promise<void> {
		this.stopped = true;
		// Installer writes and bounded secondary process proof leaves must actually
		// settle before cleanup can remove their fixture or stop its primary helper.
		const admitted = await Promise.allSettled([this.fixturePreparation, ...this.secondaryLaunches]);
		// The approved proof leaf has its own fixed 30s bound. Await the actual
		// custody-transfer chain, never a timeout race that leaves it signaling later.
		try {
			await this.mainLossObservation;
		} catch {
			/* The scenario retains its primary error; exact proof custody is now transferred. */
		}
		// If interrupted during the SDK handshake, retain the temp root until its
		// launched process is known (or the SDK's bounded launch has failed).
		try {
			await this.launchPromise;
		} catch {
			/* Original launch failure is reported by the caller. */
		}
		// An interruption while the native connect is pending must not orphan a
		// late observer. Its native timeout/binding deadlines are bounded.
		try {
			await this.rendererObservation;
		} catch {
			/* Primary scenario failure is retained. */
		}
		if (this.trackingTimer) clearInterval(this.trackingTimer);
		await this.tracking;
		const errors: string[] = [];
		let cleanupVerified = false;
		const remember = (error: unknown): void => {
			errors.push(error instanceof Error ? error.message : String(error));
		};
		for (const result of admitted) if (result.status === "rejected") remember(result.reason);
		const manifest = this.fixture.manifest;
		const normalAcceptance = failure === undefined && manifest.failure === null;
		const shutdown: DesktopLabShutdownEvidence = {
			gracefulQuit: { attempted: false, outcome: "not_attempted" },
			remainingBeforeFallback: null,
			fallbackUsed: false,
		};
		manifest.shutdown = shutdown;
		manifest.status = "stopping";
		if (failure !== undefined) manifest.failure = failure instanceof Error ? failure.message : String(failure);
		if (this.rendererObserver) {
			try {
				await withDesktopDeadline(this.rendererObserver.close(), "Desktop observer disconnect", 5_000);
				const currentMain = (await listDesktopProcesses()).find((entry) => entry.pid === this.originalMain?.pid);
				if (!this.originalMain || !currentMain || !sameDesktopProcess(this.originalMain, currentMain))
					throw new Error("Desktop observer disconnect did not preserve the original application.");
				await writeJsonAtomic(join(manifest.artifactDir, "renderer-observer-disconnect.json"), {
					disconnected: true,
					mainPid: currentMain.pid,
					mainBirth: currentMain.startedAt,
					originalApplicationAlive: true,
				});
			} catch {
				this.fixture.keepTemp = true;
				remember(new Error("Desktop renderer observer disconnect was not confirmed."));
			}
		}
		if (this.application) {
			try {
				await this.trackProcesses();
			} catch (error) {
				remember(error);
			}
			shutdown.gracefulQuit = { attempted: true, outcome: "unconfirmed" };
			const attemptedAt = new Date().toISOString();
			try {
				await withDesktopDeadline(this.application.close(), "Electron graceful close", 15_000);
				// Installed Playwright invokes app.quit and awaits application Close.
				// This records that SDK boundary, not a typed runtime shutdown receipt.
				shutdown.gracefulQuit.outcome = "sdk_close_completed";
			} catch (error) {
				remember(error);
				try {
					await captureDesktopShutdownEvidence(this.fixture, {
						attemptedAt,
						timedOutAt: new Date().toISOString(),
						originalMain: this.originalMain,
						helper: this.knownProcesses.find((process) => process.pid === manifest.helperPid) ?? null,
						retainedProcesses: this.knownProcesses,
					});
				} catch {
					// Diagnostic failure must never bypass exact cleanup or auth removal.
					remember(new Error("Desktop shutdown timeout evidence could not be retained."));
				}
			}
		} else {
			// A failed SDK handshake can leave a helper after the main process exits.
			// Only the exact packaged path plus this run's unique marker is admitted.
			try {
				await this.trackProcesses();
			} catch (error) {
				remember(error);
			}
		}
		try {
			// Give normal shutdown a brief opportunity before exact-identity fallback.
			for (let attempt = 0; attempt < 20; attempt += 1) {
				shutdown.remainingBeforeFallback = collectOwnedDesktopProcesses(
					await listDesktopProcesses(),
					[],
					this.knownProcesses,
				);
				if (shutdown.remainingBeforeFallback.length === 0) break;
				if (attempt < 19) await wait(100);
			}
		} catch (error) {
			shutdown.remainingBeforeFallback = null;
			remember(error);
		}
		try {
			if (shutdown.remainingBeforeFallback?.length === 0) {
				manifest.remainingPids = [];
			} else {
				shutdown.fallbackUsed = true;
				manifest.remainingPids = await stopOwnedDesktopProcesses(this.knownProcesses);
			}
			cleanupVerified = true;
			if (manifest.remainingPids.length > 0)
				errors.push(`Desktop cleanup left processes running: ${manifest.remainingPids.join(", ")}.`);
		} catch (error) {
			remember(error);
		}
		if (normalAcceptance) {
			if (shutdown.gracefulQuit.outcome !== "sdk_close_completed")
				errors.push("Desktop graceful Quit was not confirmed.");
			if (shutdown.fallbackUsed) errors.push("Desktop graceful Quit required fallback process cleanup.");
		}
		try {
			const forbidden = await readFile(this.fixture.forbiddenHostLaunchLogPath, "utf8");
			if (forbidden.trim()) errors.push("Desktop Agent Lab invoked a forbidden host launcher.");
		} catch (error) {
			remember(error);
		}
		// Native close/exact cleanup can settle an inspection that timed out at its caller.
		// Never delete its fixture or publish a final manifest while that old writer remains admitted.
		this.logsClosed = true;
		let capturesSettled = false;
		try {
			const outcomes = await withDesktopDeadline(
				Promise.allSettled([...this.captures, this.tracking, this.configEvidence.snapshot(), this.logWrites]),
				"Desktop admitted capture drain",
				5_000,
			);
			capturesSettled = true;
			for (const outcome of outcomes) if (outcome.status === "rejected") remember(outcome.reason);
		} catch {
			this.fixture.keepTemp = true;
			remember(new Error("Desktop admitted capture drain was not confirmed; fixture retained."));
		}
		manifest.stoppedAt = new Date().toISOString();
		try {
			await removeDesktopProviderProfiles(this.fixture.config.tempRoot);
		} catch (error) {
			remember(error);
		}
		if (capturesSettled)
			await writeJsonAtomic(join(manifest.artifactDir, "websockets.json"), this.sockets.snapshot());
		if (errors.length > 0) manifest.failure = [manifest.failure, ...errors].filter(Boolean).join("\n");
		manifest.status = manifest.failure ? "failed" : "stopped";
		if (capturesSettled) await writeJsonAtomic(this.fixture.manifestPath, manifest);
		if (capturesSettled && !this.fixture.keepTemp && cleanupVerified && manifest.remainingPids.length === 0) {
			for (const root of this.fixture.managedInstallationRoots ?? []) {
				if (!isFileSystemPathWithin(this.fixture.config.tempRoot, root))
					throw new Error("Managed desktop cleanup escaped the isolated fixture.");
				await setDesktopTreeWritable(root, true);
			}
			await rm(this.fixture.config.tempRoot, { recursive: true, force: true });
		}
		if (errors.length > 0) throw new Error(errors.join("\n"));
	}
}
