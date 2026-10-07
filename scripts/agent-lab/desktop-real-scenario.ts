import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page, WebSocket } from "playwright-core";
import { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../../src/core/api/task-session";
import { buildShellCommandLine } from "../../src/core/shell";
import { type DesktopLabDriver, withDesktopDeadline } from "./desktop-driver";
import { collectOwnedDesktopProcesses, listDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import { readDesktopTaskSession } from "./desktop-session-evidence";
import type { DesktopLabProcess } from "./desktop-types";
import { writeJsonAtomic } from "./paths";

export function projectDesktopRealSession(summary: RuntimeTaskSessionSummary) {
	return {
		taskId: summary.taskId,
		agentId: summary.agentId,
		sessionInstanceId: summary.sessionInstanceId ?? null,
		providerSessionId: summary.resumeSessionId ?? null,
		pid: summary.pid,
		state: summary.state,
		reviewReason: summary.reviewReason,
		interactionWaiting: summary.outstandingInteraction?.status === "waiting",
		interactionPresent: summary.outstandingInteraction !== null,
		permissionWaiting:
			summary.outstandingInteraction?.kind === "permission" &&
			summary.outstandingInteraction.status === "waiting" &&
			summary.outstandingInteraction.sessionInstanceId === summary.sessionInstanceId,
		hooks: summary.recentProviderHookOrderObservations
			.filter(
				(hook) =>
					hook.sessionInstanceId === summary.sessionInstanceId &&
					hook.source === summary.agentId &&
					(!hook.providerSessionId || hook.providerSessionId === summary.resumeSessionId),
			)
			.map((hook) => ({ event: hook.event, hookEventName: hook.hookEventName, deliveryId: hook.deliveryId })),
	};
}

export type DesktopRealSessionEvidence = ReturnType<typeof projectDesktopRealSession>;

class DesktopScenarioInconclusive extends Error {}

// A selected fallback row is enabled while config is loading, but has no command.
// Require the catalog command before accepting the renderer's enabled provider row.
export const DESKTOP_REAL_PROVIDER_MENU_NAMES = {
	codex: /^OpenAI Codex codex(?:\s|$)/,
	claude: /^Claude Code claude(?:\s|$)/,
} as const;

export function assertDesktopExactRecovery(
	before: DesktopRealSessionEvidence,
	after: DesktopRealSessionEvidence,
): void {
	if (!before.providerSessionId || before.providerSessionId !== after.providerSessionId)
		throw new Error("Real desktop recovery did not retain the exact provider session ID.");
	if (!before.sessionInstanceId || !after.sessionInstanceId || before.sessionInstanceId === after.sessionInstanceId)
		throw new Error("Real desktop recovery did not replace the PTY launch identity.");
	if (before.agentId !== after.agentId || !after.pid || after.hooks.length === 0)
		throw new Error("Real desktop recovery lacks a live provider and a fresh native hook.");
	if (after.agentId === "codex" && !hasDesktopCodexResumeHooks(after))
		throw new Error("Real Codex recovery lacks current SessionStart and UserPromptSubmit hooks.");
}

export function hasDesktopCodexResumeHooks(
	session: DesktopRealSessionEvidence,
	excludedDeliveries: readonly string[] = [],
): boolean {
	const hooks = session.hooks.filter((hook) => !excludedDeliveries.includes(hook.deliveryId));
	return (
		session.agentId === "codex" &&
		hooks.some((hook) => hook.event === "activity" && hook.hookEventName?.toLowerCase() === "sessionstart") &&
		hooks.some((hook) => hook.event === "to_in_progress" && hook.hookEventName?.toLowerCase() === "userpromptsubmit")
	);
}

async function readSession(stateHome: string, taskId: string): Promise<DesktopRealSessionEvidence | null> {
	const summary = await readDesktopTaskSession(stateHome, taskId);
	return summary ? projectDesktopRealSession(summary) : null;
}

type RealSessionWaitLabel = "native-work" | "permission" | "resume-ready" | "exact-recovery" | "provider-stopped";
interface RealTimeoutCaptureModule {
	app: { isPackaged: boolean; getAppPath(): string; getPath(name: "exe" | "userData"): string };
	BrowserWindow: {
		getAllWindows(): Array<{
			id: number;
			webContents: {
				id: number;
				getURL(): string;
				getOSProcessId(): number;
				capturePage(
					rect: undefined,
					options: { stayHidden: true; stayAwake: false },
				): Promise<{
					isEmpty(): boolean;
					getSize(scaleFactor: 1): { width: number; height: number };
					toPNG(options: { scaleFactor: 1 }): Buffer;
				}>;
			};
		}>;
	};
}
interface RealTimeoutCaptureIdentity {
	mainPid: number;
	executablePath: string;
	appPath: string;
	userDataPath: string;
	url: string;
	maxPngBytes: number;
}

/** Serialized into the owned Electron main process; contains no module helpers or fixture closure. */
export async function captureDesktopRealTimeoutWindow(
	{ app, BrowserWindow }: RealTimeoutCaptureModule,
	expected: RealTimeoutCaptureIdentity,
) {
	const windows = BrowserWindow.getAllWindows();
	const window = windows[0];
	if (
		process.pid !== expected.mainPid ||
		!app.isPackaged ||
		app.getAppPath() !== expected.appPath ||
		app.getPath("exe") !== expected.executablePath ||
		app.getPath("userData") !== expected.userDataPath ||
		windows.length !== 1 ||
		!window ||
		window.webContents.getURL() !== expected.url ||
		!/^app:\/\/quarterdeck\/(?!__desktop\/)/u.test(expected.url)
	)
		throw new Error("Real timeout capture refused another application or window.");
	const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: false });
	const size = image.getSize(1);
	if (image.isEmpty() || size.width <= 0 || size.height <= 0 || size.width > 4096 || size.height > 4096)
		throw new Error("Real timeout capture image is unavailable or exceeds its bound.");
	const png = image.toPNG({ scaleFactor: 1 });
	if (png.length === 0 || png.length > expected.maxPngBytes)
		throw new Error("Real timeout capture PNG exceeds its bound.");
	return {
		png: png.toString("base64"),
		sizeBytes: png.length,
		windowId: window.id,
		webContentsId: window.webContents.id,
		rendererPid: window.webContents.getOSProcessId(),
	};
}

async function retainTimeoutScreenshot(page: Page, driver: DesktopLabDriver, label: RealSessionWaitLabel) {
	const maxPngBytes = 8 * 1024 * 1024;
	const mainPid = driver.fixture.manifest.mainPid;
	if (!mainPid) throw new Error("Real timeout capture lacks the owned application identity.");
	const shot = await withDesktopDeadline(
		driver.app.evaluate(captureDesktopRealTimeoutWindow, {
			mainPid,
			executablePath: driver.fixture.manifest.executablePath,
			appPath: join(driver.fixture.manifest.appPath, "Contents", "Resources", "app.asar"),
			userDataPath: driver.fixture.config.userDataPath,
			url: page.url(),
			maxPngBytes,
		}),
		"Real timeout native capture",
		2_000,
	);
	if (shot.png.length > Math.ceil(maxPngBytes / 3) * 4) throw new Error("Real timeout PNG exceeds its bridge bound.");
	const png = Buffer.from(shot.png, "base64");
	if (png.length === 0 || png.length > maxPngBytes || png.length !== shot.sizeBytes)
		throw new Error("Real timeout PNG failed its bound.");
	const file = `real-${label}-timeout.png`;
	await withDesktopDeadline(
		writeFile(join(driver.fixture.manifest.artifactDir, file), png),
		"Real timeout PNG publication",
		2_000,
	);
	return {
		status: "captured" as const,
		file,
		sizeBytes: png.length,
		windowId: shot.windowId,
		webContentsId: shot.webContentsId,
		rendererPid: shot.rendererPid,
	};
}

export async function waitForSession(
	driver: DesktopLabDriver,
	taskId: string,
	label: RealSessionWaitLabel,
	condition: (summary: DesktopRealSessionEvidence) => boolean,
	timeoutMs: number,
	page: Page,
): Promise<DesktopRealSessionEvidence> {
	const deadline = Date.now() + timeoutMs;
	let latest: { observedAt: string; session: DesktopRealSessionEvidence } | null = null;
	let lastPollStatus: "present" | "missing" = "missing";
	while (Date.now() < deadline) {
		const summary = await readSession(driver.fixture.config.stateHome, taskId);
		lastPollStatus = summary ? "present" : "missing";
		if (summary) latest = { observedAt: new Date().toISOString(), session: summary };
		if (summary && condition(summary)) return summary;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	const failure = new DesktopScenarioInconclusive(
		`Real provider scenario inconclusive: no ${label} within ${timeoutMs}ms; no approval was sent.`,
	);
	let finalRead: { status: "present"; session: DesktopRealSessionEvidence } | { status: "missing" | "unavailable" };
	try {
		const session = await withDesktopDeadline(
			readSession(driver.fixture.config.stateHome, taskId),
			"Real timeout final session read",
			2_000,
		);
		finalRead = session ? { status: "present", session } : { status: "missing" };
	} catch {
		finalRead = { status: "unavailable" };
	}
	const screenshot = await retainTimeoutScreenshot(page, driver, label).catch(() => ({
		status: "unavailable" as const,
		reason: "capture_unconfirmed" as const,
	}));
	try {
		await withDesktopDeadline(
			writeJsonAtomic(join(driver.fixture.manifest.artifactDir, `real-${label}-timeout.json`), {
				stage: "wait_for_session",
				label,
				timeoutMs,
				observedAt: new Date().toISOString(),
				latest,
				lastPollStatus,
				finalRead,
				screenshot,
				approved: false,
			}),
			"Real timeout evidence publication",
			2_000,
		);
	} catch {
		// Evidence publication is best effort; retain the original scenario outcome.
	}
	try {
		await withDesktopDeadline(driver.inspect(`real-${label}-inconclusive`), "Real timeout inspection", 2_000);
	} catch {
		// Diagnostic failure must not replace the original timeout or prevent cleanup.
	}
	throw failure;
}

async function assertNoFileEffect(proofPath: string): Promise<void> {
	try {
		await stat(proofPath);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	throw new Error("Real provider wrote the fixture proof file without the required approval boundary.");
}

export const DESKTOP_CODEX_RESUME_TURN =
	"Cancel the previous synthetic write request. Do not execute the write or any tool. Do not read or modify files, run commands, or use network tools. Reply only 'cancelled'.";

const resumeCheckpointSchema = z
	.object({
		version: z.literal(1),
		reviewer: z.literal("agent"),
		stage: z.enum(["before_type", "before_enter"]),
		challengeId: z.string().uuid(),
		runId: z.string().min(1),
		taskId: z.string().min(1),
		sessionInstanceId: z.string().min(1),
		providerSessionId: z.string().min(1),
		pid: z.number().int().positive(),
		startedAt: z.string().min(1),
		captureSha256: z.string().regex(/^[a-f0-9]{64}$/),
		outputEpoch: z.number().int().nonnegative(),
		documentNonce: z.string().uuid(),
		windowId: z.number().int().positive(),
		webContentsId: z.number().int().positive(),
		rendererPid: z.number().int().positive(),
		expiresAt: z.number().int().positive(),
		expectedText: z.string().nullable(),
	})
	.strict();
export type DesktopCodexResumeCheckpoint = z.infer<typeof resumeCheckpointSchema>;
const resumeDecisionSchema = resumeCheckpointSchema.extend({ decision: z.enum(["accept", "refuse"]) }).strict();

/** Internal agent visual review, never a provider approval or user authorization. */
export function assertDesktopCodexResumeDecision(
	checkpoint: DesktopCodexResumeCheckpoint,
	decision: unknown,
	now: number,
): void {
	const parsed = resumeDecisionSchema.safeParse(decision);
	if (!parsed.success || parsed.data.decision !== "accept" || now >= checkpoint.expiresAt)
		throw new DesktopScenarioInconclusive(
			"Codex resume agent review refused, expired, or unavailable; no Enter sent.",
		);
	const { decision: _decision, ...identity } = parsed.data;
	if (JSON.stringify(identity) !== JSON.stringify(resumeCheckpointSchema.parse(checkpoint)))
		throw new DesktopScenarioInconclusive("Codex resume agent review belongs to another checkpoint; no Enter sent.");
}

export function assertDesktopCodexResumeIdentity(
	before: DesktopRealSessionEvidence,
	replacement: DesktopRealSessionEvidence,
	current: DesktopRealSessionEvidence | null,
	owned: { main: DesktopLabProcess; helper: DesktopLabProcess; provider: DesktopLabProcess; old: DesktopLabProcess },
	processes: DesktopLabProcess[],
): void {
	if (
		before.agentId !== "codex" ||
		replacement.agentId !== "codex" ||
		replacement.taskId !== before.taskId ||
		!before.providerSessionId ||
		!before.sessionInstanceId ||
		!replacement.sessionInstanceId ||
		replacement.sessionInstanceId === before.sessionInstanceId ||
		replacement.providerSessionId !== before.providerSessionId ||
		!current ||
		current.agentId !== "codex" ||
		current.taskId !== before.taskId ||
		current.sessionInstanceId !== replacement.sessionInstanceId ||
		current.providerSessionId !== before.providerSessionId ||
		current.pid !== owned.provider.pid ||
		current.pid !== replacement.pid ||
		current.state !== "awaiting_review" ||
		current.reviewReason === "error" ||
		current.interactionPresent ||
		current.interactionWaiting ||
		current.permissionWaiting ||
		sameDesktopProcess(owned.old, owned.provider) ||
		processes.some((process) => sameDesktopProcess(process, owned.old)) ||
		![owned.main, owned.helper, owned.provider].every((expected) =>
			processes.some((process) => sameDesktopProcess(process, expected)),
		) ||
		!collectOwnedDesktopProcesses(processes, [owned.main.pid]).some((process) =>
			sameDesktopProcess(process, owned.helper),
		) ||
		!collectOwnedDesktopProcesses(processes, [owned.helper.pid]).some((process) =>
			sameDesktopProcess(process, owned.provider),
		)
	)
		throw new DesktopScenarioInconclusive("Codex resume identity or input boundary is unconfirmed; no Enter sent.");
}

interface ResumeCapture {
	captureSha256: string;
	outputEpoch: number;
	documentNonce: string;
	windowId: number;
	webContentsId: number;
	rendererPid: number;
}
interface CodexResumeTurnPorts {
	check(): Promise<void>;
	capture(stage: DesktopCodexResumeCheckpoint["stage"], publish: boolean): Promise<ResumeCapture>;
	review(checkpoint: DesktopCodexResumeCheckpoint): Promise<unknown>;
	insertText(text: string): Promise<void>;
	enter(): Promise<void>;
	now(): number;
	isCurrent(capture: ResumeCapture): boolean;
}

/** At most one text insertion and Enter; each needs its own exact visual challenge. */
export async function runDesktopCodexResumeTurn(
	identity: Pick<
		DesktopCodexResumeCheckpoint,
		"runId" | "taskId" | "sessionInstanceId" | "providerSessionId" | "pid" | "startedAt"
	>,
	ports: CodexResumeTurnPorts,
): Promise<DesktopCodexResumeCheckpoint[]> {
	const checkpoints: DesktopCodexResumeCheckpoint[] = [];
	for (const stage of ["before_type", "before_enter"] as const) {
		await ports.check();
		const capture = await ports.capture(stage, true);
		const checkpoint = resumeCheckpointSchema.parse({
			version: 1,
			reviewer: "agent",
			stage,
			challengeId: randomUUID(),
			...identity,
			...capture,
			expiresAt: ports.now() + 120_000,
			expectedText: stage === "before_enter" ? DESKTOP_CODEX_RESUME_TURN : null,
		});
		const decision = await ports.review(checkpoint);
		assertDesktopCodexResumeDecision(checkpoint, decision, ports.now());
		await ports.check();
		const current = await ports.capture(stage, false);
		if (JSON.stringify(current) !== JSON.stringify(capture))
			throw new DesktopScenarioInconclusive(
				"Codex resume image, document, or output changed during review; no Enter sent.",
			);
		await ports.check();
		if (ports.now() >= checkpoint.expiresAt)
			throw new DesktopScenarioInconclusive("Codex resume agent review expired before input; no Enter sent.");
		if (!ports.isCurrent(capture))
			throw new DesktopScenarioInconclusive("Codex resume output changed before input; no Enter sent.");
		checkpoints.push(checkpoint);
		if (stage === "before_type") await ports.insertText(DESKTOP_CODEX_RESUME_TURN);
		else await ports.enter();
	}
	return checkpoints;
}

async function readResumeDecision(path: string): Promise<unknown | null> {
	let file: FileHandle | undefined;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const info = await file.stat();
		if (!info.isFile() || info.size > 16 * 1024) throw new Error("Invalid decision file.");
		return JSON.parse(await file.readFile("utf8")) as unknown;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw new DesktopScenarioInconclusive("Codex resume decision file is unconfirmed; no Enter sent.");
	} finally {
		await file?.close();
	}
}

/** Observe only existing replacement traffic; never parse output or send a socket message. */
export function observeDesktopCodexResumeOutput(page: Page, taskId: string) {
	let outputEpoch = 0;
	let issue:
		| "malformed_endpoint"
		| "pair_identity"
		| "duplicate_socket"
		| "closed_socket"
		| "socket_error"
		| "document_closed"
		| "document_navigation"
		| "route"
		| null = null;
	let boundUrl: string | null = null;
	let clientId: string | null = null;
	const sockets = new Map<string, WebSocket>();
	let pairAcquiredAt: number | null = null;
	let projectId: string | null = null;
	const listeners: Array<() => void> = [];
	const refuse = (reason: string): never => {
		throw new DesktopScenarioInconclusive(
			`Codex resume output observation is unavailable (${reason}); no Enter sent.`,
		);
	};
	const onSocket = (socket: WebSocket) => {
		let url: URL;
		try {
			url = new URL(socket.url());
		} catch {
			issue ??= "malformed_endpoint";
			return;
		}
		if (url.searchParams.get("taskId") !== taskId || !/^\/api\/terminal\/(io|control)$/u.test(url.pathname)) return;
		const client = url.searchParams.get("clientId"),
			project = url.searchParams.get("projectId");
		if (!client || !project || (projectId && project !== projectId) || (clientId && client !== clientId)) {
			issue ??= "pair_identity";
			return;
		}
		if (sockets.has(url.pathname)) {
			issue ??= "duplicate_socket";
			return;
		}
		clientId = client;
		projectId = project;
		sockets.set(url.pathname, socket);
		if (sockets.size === 2) pairAcquiredAt = Date.now();
		const received = () => {
			outputEpoch += 1;
		};
		const closed = () => {
			issue ??= "closed_socket";
		};
		const failed = () => {
			issue ??= "socket_error";
		};
		socket.on("framereceived", received);
		socket.on("close", closed);
		socket.on("socketerror", failed);
		listeners.push(() => {
			socket.off("framereceived", received);
			socket.off("close", closed);
			socket.off("socketerror", failed);
		});
	};
	const closed = () => {
		issue ??= "document_closed";
	};
	const navigated = () => {
		if (boundUrl) issue ??= "document_navigation";
	};
	page.on("websocket", onSocket);
	page.on("close", closed);
	page.on("crash", closed);
	page.on("framenavigated", navigated);
	return {
		async waitForPair() {
			const deadline = Date.now() + 5_000;
			while (true) {
				if (issue) refuse(issue);
				if (sockets.size === 2 && pairAcquiredAt !== null) return pairAcquiredAt;
				if (Date.now() >= deadline) refuse("missing_pair");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		},
		bind() {
			if (issue) refuse(issue);
			if (sockets.size !== 2) refuse("missing_pair");
			try {
				const url = new URL(page.url());
				if (
					url.searchParams.get("task") !== taskId ||
					decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "") !== projectId
				)
					issue ??= "route";
			} catch {
				issue ??= "route";
			}
			if (issue) refuse(issue);
			boundUrl = page.url();
		},
		read() {
			if (issue) refuse(issue);
			if (!boundUrl || page.url() !== boundUrl) refuse("route");
			if (sockets.size !== 2) refuse("missing_pair");
			return outputEpoch;
		},
		dispose() {
			page.off("websocket", onSocket);
			page.off("close", closed);
			page.off("crash", closed);
			page.off("framenavigated", navigated);
			for (const dispose of listeners) dispose();
		},
	};
}

/** Own the listener before Restart can synchronously construct replacement sockets. */
export async function restartDesktopCodexWithResumeObservation(
	page: Page,
	taskId: string,
	restart: () => Promise<void>,
) {
	const observation = observeDesktopCodexResumeOutput(page, taskId);
	try {
		await restart();
		return observation;
	} catch (error) {
		observation.dispose();
		throw error;
	}
}

/** Serialized renderer observation: a document nonce, not terminal content. */
export function readDesktopCodexResumeDocument(expected: string | null): string {
	const existing: unknown = Reflect.get(globalThis, "__quarterdeckLabCodexResumeDocument");
	if (expected === null && existing === undefined) {
		const nonce = (globalThis as typeof globalThis & { crypto: { randomUUID(): string } }).crypto.randomUUID();
		Reflect.set(globalThis, "__quarterdeckLabCodexResumeDocument", nonce);
		return nonce;
	}
	if (typeof existing !== "string" || (expected !== null && existing !== expected))
		throw new Error("Codex resume document changed.");
	return existing;
}

/** Echo settlement only; pixels and fresh hooks remain the semantic authorities. */
export async function waitDesktopCodexResumeQuiet(
	read: () => number,
	now: () => number = Date.now,
	pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 25)),
	pairAcquiredAt?: number,
): Promise<void> {
	const started = now();
	const firstCapture = pairAcquiredAt !== undefined;
	const deadlineMs = firstCapture ? 10_000 : 2_000;
	const quietMs = firstCapture ? 1_000 : 250;
	const earliestCapture = firstCapture ? pairAcquiredAt + 2_000 : started;
	let epoch = read();
	let quietSince = started;
	while (now() - started < deadlineMs) {
		await pause();
		const current = read();
		if (current !== epoch) {
			epoch = current;
			quietSince = now();
		}
		if (now() >= earliestCapture && now() - quietSince >= quietMs) return;
	}
	throw new DesktopScenarioInconclusive("Codex resume text echo is unsettled; no Enter sent.");
}

async function submitDesktopCodexResumeTurn(
	page: Page,
	driver: DesktopLabDriver,
	before: DesktopRealSessionEvidence,
	replacement: DesktopRealSessionEvidence,
	old: DesktopLabProcess,
	proofPath: string,
	output: ReturnType<typeof observeDesktopCodexResumeOutput>,
): Promise<readonly string[]> {
	const manifest = driver.fixture.manifest;
	const main = manifest.processes.find((process) => process.pid === manifest.mainPid);
	const helper = manifest.processes.find((process) => process.pid === manifest.helperPid);
	const provider = (await listDesktopProcesses()).find((process) => process.pid === replacement.pid);
	if (!main || !helper || !provider || !replacement.sessionInstanceId || !replacement.providerSessionId)
		throw new DesktopScenarioInconclusive("Codex resume lacks exact owned identities; no Enter sent.");
	const owned = { main, helper, provider, old };
	const nonce = await withDesktopDeadline(
		page.evaluate(readDesktopCodexResumeDocument, null),
		"Codex resume document binding",
		2_000,
	);
	const pairAcquiredAt = await output.waitForPair();
	output.bind();
	await page.getByRole("textbox", { name: "Terminal input" }).focus({ timeout: 2_000 });
	let latest: DesktopRealSessionEvidence | null = null;
	let hookDeliveriesBeforeSubmission: readonly string[] = [];
	const check = async () => {
		output.read();
		if (
			(await withDesktopDeadline(
				page.evaluate(readDesktopCodexResumeDocument, nonce),
				"Codex resume document check",
				2_000,
			)) !== nonce
		)
			throw new DesktopScenarioInconclusive("Codex resume document is unconfirmed; no Enter sent.");
		latest = await withDesktopDeadline(
			readSession(driver.fixture.config.stateHome, before.taskId),
			"Codex resume session check",
			2_000,
		);
		assertDesktopCodexResumeIdentity(before, replacement, latest, owned, await listDesktopProcesses());
		await assertNoFileEffect(proofPath);
	};
	const checkpoints = await runDesktopCodexResumeTurn(
		{
			runId: manifest.runId,
			taskId: before.taskId,
			sessionInstanceId: replacement.sessionInstanceId,
			providerSessionId: replacement.providerSessionId,
			pid: provider.pid,
			startedAt: provider.startedAt,
		},
		{
			check,
			now: Date.now,
			isCurrent: (capture) => output.read() === capture.outputEpoch,
			async capture(stage, publish) {
				// Settle expected echo before freezing the challenge; never retry input
				// or recapture an invalidated challenge to manufacture acceptance.
				if (publish)
					await waitDesktopCodexResumeQuiet(
						output.read,
						Date.now,
						undefined,
						stage === "before_type" ? pairAcquiredAt : undefined,
					);
				const epoch = output.read();
				const image = await withDesktopDeadline(
					driver.app.evaluate(captureDesktopRealTimeoutWindow, {
						mainPid: main.pid,
						executablePath: manifest.executablePath,
						appPath: join(manifest.appPath, "Contents", "Resources", "app.asar"),
						userDataPath: driver.fixture.config.userDataPath,
						url: page.url(),
						maxPngBytes: 8 * 1024 * 1024,
					}),
					"Codex resume visual checkpoint",
					2_000,
				);
				if (
					output.read() !== epoch ||
					(await withDesktopDeadline(
						page.evaluate(readDesktopCodexResumeDocument, nonce),
						"Codex resume capture document check",
						2_000,
					)) !== nonce
				)
					throw new DesktopScenarioInconclusive("Codex resume output changed during capture; no Enter sent.");
				const png = Buffer.from(image.png, "base64");
				if (!png.length || png.length !== image.sizeBytes || png.length > 8 * 1024 * 1024)
					throw new DesktopScenarioInconclusive("Codex resume capture is unconfirmed; no Enter sent.");
				if (publish)
					await withDesktopDeadline(
						writeFile(join(manifest.artifactDir, `real-resume-${stage}.png`), png),
						"Codex resume PNG publication",
						2_000,
					);
				return {
					captureSha256: createHash("sha256").update(png).digest("hex"),
					outputEpoch: epoch,
					documentNonce: nonce,
					windowId: image.windowId,
					webContentsId: image.webContentsId,
					rendererPid: image.rendererPid,
				};
			},
			async review(checkpoint) {
				const request = join(manifest.artifactDir, `real-resume-${checkpoint.stage}-request.json`);
				const decision = join(manifest.artifactDir, `real-resume-${checkpoint.stage}-decision.json`);
				await withDesktopDeadline(writeJsonAtomic(request, checkpoint), "Codex resume request publication", 2_000);
				process.stderr.write(
					`[agent-desktop] Agent visual review required: ${request}; PNG real-resume-${checkpoint.stage}.png; decision ${decision}\n`,
				);
				while (Date.now() < checkpoint.expiresAt) {
					if (output.read() !== checkpoint.outputEpoch)
						throw new DesktopScenarioInconclusive(
							"Codex resume output changed during agent review; no Enter sent.",
						);
					const value = await withDesktopDeadline(
						readResumeDecision(decision),
						"Codex resume decision read",
						2_000,
					);
					if (value !== null) return value;
					await new Promise((resolve) => setTimeout(resolve, 150));
				}
				throw new DesktopScenarioInconclusive("Codex resume agent review deadline expired; no Enter sent.");
			},
			insertText: (text) =>
				withDesktopDeadline(page.keyboard.insertText(text), "Codex resume text insertion", 2_000),
			enter: () => {
				hookDeliveriesBeforeSubmission = latest?.hooks.map((hook) => hook.deliveryId) ?? [];
				return withDesktopDeadline(page.keyboard.press("Enter"), "Codex resume submission", 2_000);
			},
		},
	);
	await withDesktopDeadline(
		writeJsonAtomic(join(manifest.artifactDir, "real-resume-turn.json"), {
			reviewer: "agent",
			checkpoints,
			textInsertions: 1,
			submissions: 1,
			approved: false,
		}),
		"Codex resume receipt publication",
		2_000,
	);
	return hookDeliveriesBeforeSubmission;
}

/** A fixed, tiny fixture-only request. The harness never grants provider approval. */
export function desktopRealApprovalPrompt(proofPath: string): string {
	const quotedPath = buildShellCommandLine(proofPath, [], "darwin");
	return `Synthetic compatibility check. Use your shell tool to run exactly: printf 'synthetic-desktop-proof\\n' > ${quotedPath}. This is the only requested change. Request permission before running it; do not bypass a denial or use another tool. Do not read other files or use network tools. After cancellation, reply only 'cancelled'.`;
}

export async function exerciseDesktopRealProvider(page: Page, driver: DesktopLabDriver): Promise<void> {
	const mode = driver.fixture.manifest.agent.mode;
	if (mode !== "real-codex" && mode !== "real-claude")
		throw new Error("Real scenario requires a real provider fixture.");
	const agentId = mode === "real-codex" ? "codex" : "claude";
	const proofPath = join(driver.fixture.config.projectPath, "desktop-real-approval-proof.txt");
	await assertNoFileEffect(proofPath);
	await page.locator("section.kb-board").waitFor({ state: "visible" });
	await page.getByRole("button", { name: "Create task", exact: true }).first().click();
	const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task" }) });
	await dialog.getByPlaceholder("Describe the task").fill(desktopRealApprovalPrompt(proofPath));
	await dialog.getByRole("button", { name: "Task harness", exact: true }).click();
	await driver.inspect("real-agent-options");
	await page.getByRole("menuitem", { name: DESKTOP_REAL_PROVIDER_MENU_NAMES[agentId] }).click();
	await dialog.getByRole("button", { name: "Start task", exact: true }).click();
	await dialog.waitFor({ state: "hidden" });
	const task = page.locator("[data-task-id]").first();
	const taskId = await task.getAttribute("data-task-id");
	if (!taskId) throw new Error("Real task did not expose its identity.");
	let resumeOutput: ReturnType<typeof observeDesktopCodexResumeOutput> | null = null;
	try {
		await task.click();
		const input = page.getByRole("textbox", { name: "Terminal input" });
		await input.waitFor({ state: "visible" });
		await waitForSession(
			driver,
			taskId,
			"native-work",
			(session) => session.agentId === agentId && session.hooks.some((hook) => hook.event === "to_in_progress"),
			60_000,
			page,
		);
		let permission: DesktopRealSessionEvidence;
		try {
			permission = await waitForSession(
				driver,
				taskId,
				"permission",
				(session) => session.permissionWaiting && Boolean(session.providerSessionId),
				30_000,
				page,
			);
		} catch (error) {
			if (!(error instanceof DesktopScenarioInconclusive)) throw error;
			const current = await readSession(driver.fixture.config.stateHome, taskId);
			if (current?.state !== "awaiting_review" || current.interactionWaiting) throw error;
			// One small clarification only; no retries or provider setup/approval answers.
			await input.focus();
			await page.keyboard.type(
				"Please request permission for the exact synthetic shell write above. Do not execute it without approval or use another tool.",
			);
			await page.keyboard.press("Enter");
			permission = await waitForSession(
				driver,
				taskId,
				"permission",
				(session) => session.permissionWaiting && Boolean(session.providerSessionId),
				45_000,
				page,
			);
		}
		await assertNoFileEffect(proofPath);
		await driver.inspect("real-permission-held");
		await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "real-permission.json"), {
			permission,
			approved: false,
			fileEffect: false,
		});
		const oldProcess = (await listDesktopProcesses()).find((process) => process.pid === permission.pid);
		if (!oldProcess) throw new Error("Real provider permission did not identify a live PTY process.");
		await task.hover();
		const restart = () =>
			task
				.getByRole("button", { name: /^(Force restart agent session|Restart agent session)$/ })
				.first()
				.click();
		if (agentId === "codex") resumeOutput = await restartDesktopCodexWithResumeObservation(page, taskId, restart);
		else await restart();
		let expectedReplacement: DesktopRealSessionEvidence | null = null;
		let hookDeliveriesBeforeSubmission: readonly string[] = [];
		if (resumeOutput) {
			expectedReplacement = await waitForSession(
				driver,
				taskId,
				"resume-ready",
				(session) =>
					session.agentId === "codex" &&
					session.providerSessionId === permission.providerSessionId &&
					Boolean(session.sessionInstanceId) &&
					session.sessionInstanceId !== permission.sessionInstanceId &&
					session.pid !== null &&
					session.state === "awaiting_review" &&
					!session.interactionPresent,
				30_000,
				page,
			);
			try {
				hookDeliveriesBeforeSubmission = await submitDesktopCodexResumeTurn(
					page,
					driver,
					permission,
					expectedReplacement,
					oldProcess,
					proofPath,
					resumeOutput,
				);
			} catch (error) {
				const screenshot = await retainTimeoutScreenshot(page, driver, "exact-recovery").catch(() => ({
					status: "unavailable" as const,
				}));
				await withDesktopDeadline(
					writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "real-resume-guard-failed.json"), {
						stage: "agent_reviewed_resume_turn",
						reviewer: "agent",
						expectedReplacement,
						screenshot,
						approved: false,
					}),
					"Codex resume failure receipt publication",
					2_000,
				).catch(() => {});
				throw error;
			}
		}
		const recovered = await waitForSession(
			driver,
			taskId,
			"exact-recovery",
			(session) =>
				session.providerSessionId === permission.providerSessionId &&
				session.sessionInstanceId !== permission.sessionInstanceId &&
				session.pid !== null &&
				(expectedReplacement
					? session.sessionInstanceId === expectedReplacement.sessionInstanceId &&
						session.pid === expectedReplacement.pid &&
						hasDesktopCodexResumeHooks(session, hookDeliveriesBeforeSubmission)
					: session.hooks.length > 0),
			60_000,
			page,
		);
		assertDesktopExactRecovery(permission, recovered);
		if ((await listDesktopProcesses()).some((process) => sameDesktopProcess(process, oldProcess)))
			throw new Error("Real provider restart left the previous PTY process alive.");
		await assertNoFileEffect(proofPath);
		await driver.inspect("real-exact-recovery");
		await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "real-recovery.json"), {
			before: permission,
			after: recovered,
			oldProcessStopped: true,
			approved: false,
			fileEffect: false,
		});
		const recoveredProcess = (await listDesktopProcesses()).find((process) => process.pid === recovered.pid);
		if (!recoveredProcess) throw new Error("Recovered provider process disappeared before isolated cleanup.");
		await driver.stopOwnedTaskProcess(recoveredProcess);
		const stopped = await waitForSession(
			driver,
			taskId,
			"provider-stopped",
			(session) => session.pid === null,
			15_000,
			page,
		);
		await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "real-stopped.json"), stopped);
		await driver.inspect("real-provider-stopped");
	} finally {
		resumeOutput?.dispose();
	}
}
