import { randomUUID } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { z } from "zod";
import { runtimeProjectStateResponseSchema } from "../../src/core/api/project-state";
import { getRuntimeDetailTerminalTaskId, RUNTIME_DETAIL_TERMINAL_TASK_PREFIX } from "../../src/core/api/task-session";
import { type DesktopLabDriver, withDesktopDeadline } from "./desktop-driver";
import {
	assertDesktopManualShellFresh,
	assertDesktopManualShellPreserved,
	type DesktopManualShellIdentity,
	type DesktopManualShellSnapshot,
	requireDesktopManualShell,
	waitForDesktopManualShellRetirement,
} from "./desktop-manual-shell-evidence";
import { listDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import type { DesktopLabProcess } from "./desktop-types";
import { DesktopProcessEvidenceSchema } from "./desktop-types";
import { writeJsonAtomic } from "./paths";

interface ManualShellNativeModule {
	BrowserWindow: {
		getAllWindows(): Array<{
			id: number;
			isVisible(): boolean;
			isFocused(): boolean;
			close(): void;
			webContents: { id: number; getURL(): string };
		}>;
	};
}
const terminalObservationSchema = z.object({
	dedicatedSlots: z.array(z.object({ taskId: z.string().nullable(), slotId: z.number() })),
	dom: z.object({
		helperTextareaCount: z.number(),
		parkingRoot: z.object({ helperTextareaCount: z.number() }).nullable(),
	}),
});

async function readRendererShell(page: Page, projectId: string, taskId: string) {
	if (decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "") !== projectId)
		throw new Error("Manual shell lane selected a different project.");
	const raw = await page.evaluate(async (id) => {
		const response = await fetch("/api/trpc/project.getState", {
			headers: { "x-quarterdeck-project-id": id },
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) throw new Error("Manual shell project query failed.");
		const text = await response.text();
		if (text.length > 2 * 1024 * 1024) throw new Error("Manual shell project query exceeds its bound.");
		const body: unknown = JSON.parse(text);
		const result = typeof body === "object" && body !== null ? Reflect.get(body, "result") : null;
		if (typeof result !== "object" || result === null) throw new Error("Missing manual shell project result.");
		const dump: unknown = Reflect.get(globalThis, "__quarterdeckDumpTerminalState");
		if (typeof dump !== "function") throw new Error("Manual terminal diagnostics unavailable.");
		return { state: Reflect.get(result, "data") as unknown, terminals: dump() as unknown };
	}, projectId);
	const state = runtimeProjectStateResponseSchema.parse(raw.state);
	if (Object.values(state.sessions).some((session) => session.agentId !== null && session.pid !== null))
		throw new Error("Manual shell lane unexpectedly started a task agent.");
	let selectedTaskTitle: string | null = null;
	if (taskId.startsWith(RUNTIME_DETAIL_TERMINAL_TASK_PREFIX)) {
		const projectTaskId = taskId.slice(RUNTIME_DETAIL_TERMINAL_TASK_PREFIX.length);
		const card = state.board.columns.flatMap((column) => column.cards).find((entry) => entry.id === projectTaskId);
		if (!card?.unstarted || new URL(page.url()).searchParams.get("task") !== projectTaskId)
			throw new Error("Detail manual shell requires its selected unstarted synthetic task.");
		selectedTaskTitle = card.title;
	}
	const terminals = terminalObservationSchema.parse(raw.terminals);
	return {
		selectedTaskTitle,
		session: state.sessions[taskId] ?? null,
		dedicatedSlotIds: terminals.dedicatedSlots.filter((slot) => slot.taskId === taskId).map((slot) => slot.slotId),
		helperTextareas: terminals.dom.helperTextareaCount,
		parkedTextareas: terminals.dom.parkingRoot?.helperTextareaCount ?? 0,
	};
}

/** The generic Open terminal control also exists in Home before board hydration. */
export async function waitForDesktopManualShellDetailSelection(
	page: Pick<Page, "locator">,
	readSelectedTaskTitle: () => Promise<string>,
): Promise<void> {
	const toolbar = page.locator("nav.kb-top-bar");
	await toolbar
		.getByRole("button", { name: "Back to board", exact: true })
		.waitFor({ state: "visible", timeout: 15_000 });
	const title = await readSelectedTaskTitle();
	await toolbar.getByText(title, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
}

async function readOwner(page: Page, driver: DesktopLabDriver, nonce: string) {
	const native = await driver.app.evaluate(({ BrowserWindow }: ManualShellNativeModule) => {
		const windows = BrowserWindow.getAllWindows();
		const window = windows[0];
		if (windows.length !== 1 || !window) throw new Error("Manual shell requires exactly one isolated window.");
		return {
			windowId: window.id,
			webContentsId: window.webContents.id,
			url: window.webContents.getURL(),
			visible: window.isVisible(),
			focused: window.isFocused(),
		};
	});
	if (native.visible || native.focused) throw new Error("Manual shell lane exposed or focused its hidden window.");
	if ((await page.evaluate(() => Reflect.get(globalThis, "__quarterdeckManualShellNonce"))) !== nonce)
		throw new Error("Manual shell lane replaced its mounted document.");
	const evidence = DesktopProcessEvidenceSchema.parse(
		JSON.parse(await readFile(driver.fixture.config.processEvidencePath, "utf8")) as unknown,
	);
	const processes = await listDesktopProcesses();
	const app = processes.find((process) => process.pid === driver.fixture.manifest.mainPid);
	const helper = processes.find((process) => process.pid === evidence.helperPid);
	const admittedApp = driver.fixture.manifest.processes.find((process) => process.pid === app?.pid);
	const admittedHelper = driver.fixture.manifest.processes.find((process) => process.pid === helper?.pid);
	if (
		!app ||
		!helper ||
		!admittedApp ||
		!admittedHelper ||
		!sameDesktopProcess(app, admittedApp) ||
		!sameDesktopProcess(helper, admittedHelper) ||
		helper.parentPid !== app.pid ||
		!evidence.generation ||
		evidence.phase !== "ready"
	)
		throw new Error("Manual shell lane lacks its exact live app/helper owner.");
	return { native, app, helper, generation: evidence.generation };
}

function assertSharedOwner(
	before: Awaited<ReturnType<typeof readOwner>>,
	after: Awaited<ReturnType<typeof readOwner>>,
) {
	if (
		before.native.windowId !== after.native.windowId ||
		before.native.webContentsId !== after.native.webContentsId ||
		before.generation !== after.generation ||
		!sameDesktopProcess(before.app, after.app) ||
		!sameDesktopProcess(before.helper, after.helper)
	)
		throw new Error("Manual shell action replaced its exact app, helper or native window.");
}

function assertOwner(before: Awaited<ReturnType<typeof readOwner>>, after: Awaited<ReturnType<typeof readOwner>>) {
	assertSharedOwner(before, after);
	if (before.native.url !== after.native.url)
		throw new Error("Manual shell action replaced its mounted document route.");
}

function publicIdentity(identity: DesktopManualShellIdentity) {
	return {
		...identity,
		process: { pid: identity.process.pid, parentPid: identity.process.parentPid, birth: identity.process.startedAt },
	};
}

function publicOwner(owner: Awaited<ReturnType<typeof readOwner>>) {
	return {
		...owner.native,
		generation: owner.generation,
		app: { pid: owner.app.pid, birth: owner.app.startedAt },
		helper: { pid: owner.helper.pid, birth: owner.helper.startedAt },
	};
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeShellProof(
	page: Page,
	driver: DesktopLabDriver,
	identity: DesktopManualShellIdentity,
	label: string,
) {
	const marker = `${label}-${randomUUID()}`;
	const path = join(driver.fixture.config.tempRoot, `${marker}.txt`);
	const input = page.locator("textarea.xterm-helper-textarea:visible");
	await input.waitFor({ state: "visible" });
	await input.focus();
	await page.keyboard.type(`printf '%s\\n' "$$" ${quoteShell(marker)} "$PWD" > ${quoteShell(path)}`);
	await page.keyboard.press("Enter");
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			if ((await stat(path)).size > 4_096) throw new Error("Manual shell marker exceeds its bound.");
			const contents = (await readFile(path, "utf8")).trimEnd().split("\n");
			if (contents.length >= 3) {
				if (
					contents.length !== 3 ||
					contents[0] !== String(identity.process.pid) ||
					contents[1] !== marker ||
					contents[2] !== identity.cwd
				)
					throw new Error("Manual shell marker came from a different process or workspace.");
				return { marker, shellPid: identity.process.pid, cwd: identity.cwd };
			}
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Manual shell PTY input did not produce its exact synthetic disk marker.");
}

export function validateDesktopManualShellSelection(options: {
	includeAgent?: boolean;
	showWindow?: boolean;
	nativeExperience?: boolean;
	performance?: boolean;
	mainLoss?: boolean;
	npmLaunch?: boolean;
	agentMode?: string;
}): void {
	if (
		options.includeAgent !== false ||
		options.showWindow ||
		options.nativeExperience ||
		options.performance ||
		options.mainLoss ||
		options.npmLaunch ||
		(options.agentMode ?? "fake") !== "fake"
	)
		throw new Error("Manual shell checks require --no-agent, a hidden window, fake mode, and no other scenario.");
}

/** Actual packaged UI panels; the existing driver exclusively owns all process cleanup. */
export async function exerciseDesktopManualShells(page: Page, driver: DesktopLabDriver): Promise<void> {
	const bundleManifest = join(driver.fixture.manifest.appPath, "Contents/Resources/runtime/bundle-manifest.json");
	if ((await stat(bundleManifest)).size > 64 * 1024) throw new Error("Packaged bundle manifest exceeds its bound.");
	await copyFile(bundleManifest, join(driver.fixture.manifest.artifactDir, "manual-shells-bundle-manifest.json"));
	const projectId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "");
	if (!projectId) throw new Error("Manual shell scenario has no selected synthetic project.");
	const surfaces = [];
	let previousSurface: { owner: Awaited<ReturnType<typeof readOwner>>; nonce: string } | null = null;
	let expectedDocumentNavigation: {
		taskId: string;
		before: ReturnType<typeof publicOwner>;
		after: ReturnType<typeof publicOwner>;
		documentNonceBefore: string;
		documentNonceAfter: string;
	} | null = null;
	for (const surface of ["home", "detail"] as const) {
		let taskId = "__home_terminal__";
		let ownerBeforeNavigation: Awaited<ReturnType<typeof readOwner>> | null = null;
		if (surface === "detail") {
			if (!previousSurface) throw new Error("Detail navigation requires the fully retired Home surface.");
			await page.getByRole("button", { name: "Create task", exact: true }).first().click();
			const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task" }) });
			await dialog.getByPlaceholder("Describe the task").fill("Synthetic unstarted manual shell acceptance");
			await dialog.getByRole("button", { name: "Create", exact: true }).click();
			await dialog.waitFor({ state: "hidden" });
			const task = page.locator("[data-task-id]").first();
			await task.waitFor({ state: "visible" });
			const id = await task.getAttribute("data-task-id");
			if (!id) throw new Error("Synthetic unstarted task lacks an identity.");
			taskId = getRuntimeDetailTerminalTaskId(id);
			ownerBeforeNavigation = await readOwner(page, driver, previousSurface.nonce);
			assertOwner(previousSurface.owner, ownerBeforeNavigation);
			// Unstarted card clicks edit the card. Its supported task deep link opens
			// Detail without starting a provider; establish the document baseline after it.
			const detailUrl = new URL(page.url());
			detailUrl.searchParams.set("task", id);
			await page.goto(detailUrl.toString());
			await waitForDesktopManualShellDetailSelection(page, async () => {
				const shell = await readRendererShell(page, projectId, taskId);
				if (!shell.selectedTaskTitle) throw new Error("Selected synthetic task lacks its authoritative title.");
				return shell.selectedTaskTitle;
			});
			if (
				(await page.evaluate(() => Reflect.get(globalThis, "__quarterdeckManualShellNonce"))) ===
				previousSurface.nonce
			)
				throw new Error("Expected Detail deep link did not replace its document.");
		}
		const nonce = randomUUID();
		await page.evaluate((value) => Reflect.set(globalThis, "__quarterdeckManualShellNonce", value), nonce);
		const owner = await readOwner(page, driver, nonce);
		if (ownerBeforeNavigation && previousSurface) {
			assertSharedOwner(ownerBeforeNavigation, owner);
			expectedDocumentNavigation = {
				taskId,
				before: publicOwner(ownerBeforeNavigation),
				after: publicOwner(owner),
				documentNonceBefore: previousSurface.nonce,
				documentNonceAfter: nonce,
			};
			await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "manual-shells-proof.json"), {
				mode: "hidden-native-close-handler",
				physicalDockHideOrReopenVerified: false,
				providerTaskStarted: false,
				expectedDocumentNavigation,
				surfaces,
			});
		}
		let trackedProcess: DesktopLabProcess | null = null;
		let lastObservation: DesktopManualShellSnapshot | null = null;
		const capture = () =>
			withDesktopDeadline(
				(async (): Promise<DesktopManualShellSnapshot> => {
					const currentOwner = await readOwner(page, driver, nonce);
					assertOwner(owner, currentOwner);
					const shell = await readRendererShell(page, projectId, taskId);
					const processes = await listDesktopProcesses();
					// A cleared runtime PID is not proof of process exit. Keep observing the
					// original exact identity after the summary disappears from live state.
					const process =
						processes.find((entry) => entry.pid === shell.session?.pid) ??
						processes.find((entry) => trackedProcess !== null && sameDesktopProcess(entry, trackedProcess)) ??
						null;
					if (process && process.parentPid !== owner.helper.pid)
						throw new Error("Manual shell process is not the isolated helper's direct child.");
					lastObservation = { ...shell, process };
					return lastObservation;
				})(),
				"Manual shell observation",
				6_000,
			);
		const open = async () => {
			await page.getByRole("button", { name: "Open terminal", exact: true }).click();
			await page.locator("textarea.xterm-helper-textarea:visible").waitFor({ state: "visible" });
			let live: DesktopManualShellIdentity | null = null;
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				const snapshot = await capture();
				if (snapshot.session?.pid && snapshot.process && snapshot.dedicatedSlotIds.length === 1) {
					live = requireDesktopManualShell(snapshot);
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (!live) {
				await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, `manual-${surface}-open-timeout.json`), {
					taskId,
					observation: lastObservation && {
						...lastObservation,
						process: lastObservation.process && {
							pid: lastObservation.process.pid,
							parentPid: lastObservation.process.parentPid,
							birth: lastObservation.process.startedAt,
						},
					},
				});
				throw new Error("Manual shell open timed out before its live PTY appeared.");
			}
			await driver.inspect(`manual-${surface}-opened`);
			trackedProcess = live.process;
			return live;
		};
		let live = await open();
		const initial = live;
		const beforeCloseMarker = await writeShellProof(page, driver, live, `${surface}-before-hidden-close`);
		await driver.app.evaluate(({ BrowserWindow }: ManualShellNativeModule) => {
			const window = BrowserWindow.getAllWindows()[0];
			if (!window || window.isVisible() || window.isFocused())
				throw new Error("Native close requires an already hidden window.");
			window.close();
		});
		assertDesktopManualShellPreserved(live, await capture());
		const afterCloseMarker = await writeShellProof(page, driver, live, `${surface}-after-hidden-close`);
		assertDesktopManualShellPreserved(live, await capture());
		const ownerAfterClose = await readOwner(page, driver, nonce);
		assertOwner(owner, ownerAfterClose);
		await driver.inspect(`manual-${surface}-hidden-close`);
		const closes = [];
		for (let cycle = 0; cycle < 2; cycle++) {
			// The last exact button is the shell panel header, after the top toolbar toggle.
			await page.getByRole("button", { name: "Close terminal", exact: true }).last().click();
			await page.getByRole("button", { name: "Open terminal", exact: true }).waitFor({ state: "visible" });
			const retired = await waitForDesktopManualShellRetirement(live, {
				capture,
				now: Date.now,
				wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			});
			closes.push({
				identity: publicIdentity(live),
				exactProcessExited: true,
				dedicatedSlots: retired.dedicatedSlotIds,
				helperTextareas: retired.helperTextareas,
				parkedTextareas: retired.parkedTextareas,
				noRestartObservedMs: 1_500,
			});
			await driver.inspect(`manual-${surface}-closed-${cycle + 1}`);
			if (cycle === 0) {
				const reopened = await open();
				assertDesktopManualShellFresh(live, reopened);
				live = reopened;
				await writeShellProof(page, driver, live, `${surface}-reopened`);
			}
		}
		surfaces.push({
			surface,
			initial: publicIdentity(initial),
			beforeCloseMarker,
			afterCloseMarker,
			ownerBeforeHiddenClose: publicOwner(owner),
			ownerAfterHiddenClose: publicOwner(ownerAfterClose),
			documentNonce: nonce,
			closes,
		});
		await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "manual-shells-proof.json"), {
			mode: "hidden-native-close-handler",
			physicalDockHideOrReopenVerified: false,
			providerTaskStarted: false,
			expectedDocumentNavigation,
			surfaces,
		});
		previousSurface = { owner, nonce };
	}
	driver.sockets.assertTraffic();
}
