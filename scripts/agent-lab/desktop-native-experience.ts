import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { readLabLaunchConfig } from "../../desktop/src/lab-launch-config.js";
import type { DesktopLabDriver } from "./desktop-driver";
import { listDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import { DesktopProcessEvidenceSchema } from "./desktop-types";

interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface NativeEvaluationModule {
	app: { isPackaged: boolean; getPath(name: "userData"): string; emit(event: "activate"): boolean };
	BrowserWindow: {
		getAllWindows(): Array<{
			id: number;
			isVisible(): boolean;
			isFocused(): boolean;
			getBounds(): Bounds;
			getContentBounds(): Bounds;
			setBounds(bounds: Bounds): void;
			close(): void;
			webContents: {
				id: number;
				getURL(): string;
				getOSProcessId(): number;
				getZoomFactor(): number;
				setZoomFactor(zoom: number): void;
				capturePage(
					rect: undefined,
					options: { stayHidden: true; stayAwake: false },
				): Promise<{
					isEmpty(): boolean;
					getSize(scaleFactor?: number): { width: number; height: number };
					toPNG(options: { scaleFactor: 1 }): { toString(encoding: "base64"): string };
				}>;
			};
		}>;
	};
}

interface NativeSnapshot {
	windowId: number;
	webContentsId: number;
	documentNonce: string;
	url: string;
	visible: boolean;
	focused: boolean;
	bounds: Bounds;
	zoom: number;
	generation: string;
	processes: Array<{ role: "app" | "helper" | "renderer"; pid: number; birth: string }>;
}
type NativeActionName = "Settings" | "Create task" | "Settings Cancel" | "Settings Save";
type NativeStep =
	| "board_capture"
	| "board_actions"
	| "settings_enter"
	| "settings_wait"
	| "settings_tab"
	| "settings_capture"
	| "settings_actions"
	| "settings_escape"
	| "create_enter"
	| "create_wait"
	| "create_escape"
	| "checkpoint";
interface NativeActionEvidence {
	name: NativeActionName;
	bounds: Bounds | null;
	viewport: { width: number; height: number };
	disabled: boolean;
	centerHit: boolean;
	pointerEventsNone: boolean;
}
interface NativeVisualDiagnostic {
	step: NativeStep;
	action?: NativeActionEvidence;
	check?: "bounds" | "hit_target";
}
class NativeVisualFailure extends Error {
	constructor(readonly diagnostic: NativeVisualDiagnostic) {
		super("Native visual or keyboard check failed.");
	}
}
interface NativeCaptureEvidence {
	file: string;
	backend: "webContents.capturePage";
	contentBounds: Bounds;
	imageSize: { width: number; height: number };
	pixelSize: { width: number; height: number };
	cssViewport: { width: number; height: number };
	zoom: number;
}
interface ZoomEvidence {
	zoom: number;
	size: { width: number; height: number };
	actions: NativeActionEvidence[];
	screenshots: string[];
	captures: NativeCaptureEvidence[];
	keyboard: {
		settingsEnter: true;
		settingsTabContained: true;
		settingsEscape: true;
		createEnter: true;
		createEscape: true;
	};
}
interface NativeExperiencePorts {
	capture(): Promise<NativeSnapshot>;
	closeWindow(): Promise<void>;
	activateWindow(): Promise<void>;
	waitForWindow(visible: boolean, focused: boolean): Promise<void>;
	configure(bounds: Bounds, zoom: number): Promise<void>;
	exercise(zoom: number, size: { width: number; height: number }): Promise<ZoomEvidence>;
	restore(snapshot: NativeSnapshot): Promise<void>;
}

type FailureStage = "initial" | "close" | "activate" | "zoom" | "keyboard_visual" | "identity" | "restore";
export class DesktopNativeExperienceError extends Error {
	readonly code = "DesktopNativeExperienceFailed";
	constructor(
		readonly failureStage: FailureStage,
		readonly restorationConfirmed: boolean,
		readonly diagnostic?: NativeVisualDiagnostic,
	) {
		super("Isolated desktop native-experience check failed; inspect its synthetic evidence.");
	}
}

function assertStable(before: NativeSnapshot, after: NativeSnapshot): void {
	if (
		before.windowId !== after.windowId ||
		before.webContentsId !== after.webContentsId ||
		before.documentNonce !== after.documentNonce ||
		before.url !== after.url ||
		before.generation !== after.generation ||
		before.processes.length !== 3 ||
		after.processes.length !== 3 ||
		before.processes.some(
			(row) =>
				!after.processes.some((next) => next.role === row.role && next.pid === row.pid && next.birth === row.birth),
		)
	)
		throw new Error("Native experience replaced its isolated window, document or runtime.");
}
function assertMode(showWindow: boolean, snapshot: NativeSnapshot): void {
	if (!showWindow && (snapshot.visible || snapshot.focused))
		throw new Error("Hidden native experience exposed or focused a window.");
}
function assertActionBounds(
	bounds: Bounds | null,
	viewport: { width: number; height: number },
): asserts bounds is Bounds {
	if (
		!bounds ||
		!Object.values(bounds).every(Number.isFinite) ||
		bounds.width <= 0 ||
		bounds.height <= 0 ||
		bounds.x < 0 ||
		bounds.y < 0 ||
		bounds.x + bounds.width > viewport.width + 1 ||
		bounds.y + bounds.height > viewport.height + 1
	)
		throw new Error("Enlarged-text primary action is outside the rendered viewport.");
}

function assertNativeAction(action: NativeActionEvidence, step: NativeStep): void {
	try {
		assertActionBounds(action.bounds, action.viewport);
	} catch {
		throw new NativeVisualFailure({ step, action, check: "bounds" });
	}
	// The scenario never edits Settings. Its intentionally inactive Save has pointer-events:none.
	const unchangedSettingsSave =
		step === "settings_actions" && action.name === "Settings Save" && action.disabled && action.pointerEventsNone;
	if (!action.centerHit && !unchangedSettingsSave)
		throw new NativeVisualFailure({ step, action, check: "hit_target" });
}

function readPngSize(png: Buffer): { width: number; height: number } {
	if (
		png.length < 24 ||
		png.length > 16 * 1024 * 1024 ||
		!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		throw new Error("Native capture returned no bounded PNG.");
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	if (width < 1 || height < 1 || width > 8192 || height > 8192)
		throw new Error("Native capture dimensions are invalid.");
	return { width, height };
}

async function proveNativeExperience(showWindow: boolean, ports: NativeExperiencePorts) {
	let before: NativeSnapshot;
	try {
		before = await ports.capture();
	} catch {
		throw new DesktopNativeExperienceError("initial", true);
	}
	let stage: FailureStage = "initial";
	let failed: FailureStage | undefined;
	let diagnostic: NativeVisualDiagnostic | undefined;
	let restorationConfirmed = false;
	const checkpoints: ZoomEvidence[] = [];
	try {
		assertMode(showWindow, before);
		if (showWindow) {
			if (!before.visible) throw new Error("Visible native experience requires a visible starting window.");
			stage = "close";
			await ports.closeWindow();
			await ports.waitForWindow(false, false);
			const hidden = await ports.capture();
			if (hidden.visible || hidden.focused) throw new Error("Window close did not hide the native window.");
			assertStable(before, hidden);
			stage = "activate";
			await ports.activateWindow();
			await ports.waitForWindow(true, true);
			const restored = await ports.capture();
			if (!restored.visible || !restored.focused)
				throw new Error("Activation did not focus the visible native window.");
			assertStable(before, restored);
		}
		for (const entry of [
			{ zoom: 1.25, width: 1180, height: 720 },
			{ zoom: 1.5, width: 1460, height: 1040 },
		]) {
			stage = "zoom";
			await ports.configure({ ...before.bounds, width: entry.width, height: entry.height }, entry.zoom);
			const configured = await ports.capture();
			assertMode(showWindow, configured);
			assertStable(before, configured);
			if (
				configured.zoom !== entry.zoom ||
				configured.bounds.width !== entry.width ||
				configured.bounds.height !== entry.height
			)
				throw new Error("Requested desktop zoom or viewport size was not applied.");
			stage = "keyboard_visual";
			checkpoints.push(await ports.exercise(entry.zoom, { width: entry.width, height: entry.height }));
			stage = "identity";
			const after = await ports.capture();
			assertMode(showWindow, after);
			assertStable(before, after);
		}
	} catch (error) {
		failed = stage;
		if (error instanceof NativeVisualFailure) diagnostic = error.diagnostic;
	} finally {
		try {
			await ports.restore(before);
			const restored = await ports.capture();
			assertMode(showWindow, restored);
			assertStable(before, restored);
			restorationConfirmed =
				restored.zoom === before.zoom &&
				!Object.keys(before.bounds).some(
					(key) => Reflect.get(before.bounds, key) !== Reflect.get(restored.bounds, key),
				);
			if (!restorationConfirmed) failed ??= "restore";
		} catch {
			failed ??= "restore";
		}
	}
	if (failed) throw new DesktopNativeExperienceError(failed, restorationConfirmed, diagnostic);
	return {
		mode: showWindow ? "visible" : "hidden",
		before,
		checkpoints,
		restorationConfirmed: true as const,
		visibleCloseActivateFocusVerified: showWindow,
	};
}

/** Requires an already-ready isolated fixture on its project board. Does not launch or stop any process. */
export async function exerciseDesktopNativeExperience(page: Page, driver: DesktopLabDriver) {
	const fixture = driver.fixture;
	const config = readLabLaunchConfig(fixture.configPath);
	if (
		fixture.manifest.status !== "ready" ||
		config.stateHome !== fixture.config.stateHome ||
		config.userDataPath !== fixture.config.userDataPath ||
		fixture.environment.QUARTERDECK_DESKTOP_LAB_CONFIG !== fixture.configPath ||
		!page.url().startsWith("app://quarterdeck/")
	)
		throw new DesktopNativeExperienceError("initial", true);
	await page.locator("section.kb-board").waitFor({ state: "visible" });
	await driver.inspect("native-before");
	const expectedDocumentNonce = randomUUID();
	if (
		!(await page.evaluate(
			(nonce) => Reflect.set(globalThis, "__quarterdeckLabNativeDocumentNonce", nonce),
			expectedDocumentNonce,
		))
	)
		throw new DesktopNativeExperienceError("initial", true);
	const capture = async (): Promise<NativeSnapshot> => {
		const window = await driver.app.evaluate(({ app, BrowserWindow }: NativeEvaluationModule, userData) => {
			const windows = BrowserWindow.getAllWindows();
			const current = windows[0];
			if (
				!app.isPackaged ||
				app.getPath("userData") !== userData ||
				windows.length !== 1 ||
				!current?.webContents.getURL().startsWith("app://quarterdeck/")
			)
				throw new Error("Native experience refused a non-isolated window.");
			return {
				windowId: current.id,
				webContentsId: current.webContents.id,
				url: current.webContents.getURL(),
				visible: current.isVisible(),
				focused: current.isFocused(),
				bounds: current.getBounds(),
				zoom: current.webContents.getZoomFactor(),
				rendererPid: current.webContents.getOSProcessId(),
			};
		}, config.userDataPath);
		const evidence = DesktopProcessEvidenceSchema.parse(
			JSON.parse(await readFile(config.processEvidencePath, "utf8")) as unknown,
		);
		if (
			evidence.phase !== "ready" ||
			!evidence.generation ||
			!evidence.helperPid ||
			evidence.appPid !== fixture.manifest.mainPid
		)
			throw new Error("Native experience has no ready owned runtime.");
		const processes = await listDesktopProcesses();
		const identities = (
			[
				{ role: "app", pid: evidence.appPid },
				{ role: "helper", pid: evidence.helperPid },
				{ role: "renderer", pid: window.rendererPid },
			] as const
		).map(({ role, pid }) => {
			const expected = fixture.manifest.processes.find((row) => row.pid === pid);
			const current = processes.find((row) => row.pid === pid);
			if (!expected || !current || !sameDesktopProcess(expected, current))
				throw new Error("Native experience lost a verified process identity.");
			return { role, pid: current.pid, birth: current.startedAt };
		});
		const documentNonce: unknown = await page.evaluate(() =>
			Reflect.get(globalThis, "__quarterdeckLabNativeDocumentNonce"),
		);
		if (documentNonce !== expectedDocumentNonce || typeof documentNonce !== "string")
			throw new Error("Native experience replaced its original renderer document.");
		return { ...window, documentNonce, generation: evidence.generation, processes: identities };
	};
	const mutateWindow = async (
		action: "close" | "configure" | "restore",
		state?: { windowId?: number; bounds: Bounds; zoom: number },
	) => {
		await driver.app.evaluate(
			({ BrowserWindow }: NativeEvaluationModule, input) => {
				const windows = BrowserWindow.getAllWindows();
				const current = windows[0];
				if (
					windows.length !== 1 ||
					!current?.webContents.getURL().startsWith("app://quarterdeck/") ||
					(input.state?.windowId !== undefined && current.id !== input.state.windowId)
				)
					throw new Error("Native experience refused to mutate another window.");
				if (input.action === "close") current.close();
				else if (input.state) {
					try {
						current.setBounds(input.state.bounds);
					} finally {
						current.webContents.setZoomFactor(input.state.zoom);
					}
				}
			},
			{ action, state },
		);
	};
	const actionEvidence = async (name: NativeActionName, action: Locator): Promise<NativeActionEvidence> => {
		await action.waitFor({ state: "visible" });
		const bounds = await action.boundingBox();
		const viewport = await page.evaluate(() => ({
			width: Reflect.get(globalThis, "innerWidth") as number,
			height: Reflect.get(globalThis, "innerHeight") as number,
		}));
		const disabled = await action.isDisabled();
		const hit = await action.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const target = element.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
			return {
				centerHit: target !== null && element.contains(target),
				pointerEventsNone: element.ownerDocument.defaultView?.getComputedStyle(element).pointerEvents === "none",
			};
		});
		return { name, bounds, viewport, disabled, ...hit };
	};
	const nativeScreenshot = async (requestedFile?: string): Promise<NativeCaptureEvidence> => {
		const before = await capture();
		const file = requestedFile ?? (before.zoom === 1 ? "native-zoom-100-board.png" : "native-initial-board.png");
		const shot = await driver.app.evaluate(
			async ({ BrowserWindow }: NativeEvaluationModule, expected) => {
				const windows = BrowserWindow.getAllWindows();
				const window = windows[0];
				if (
					windows.length !== 1 ||
					!window ||
					window.id !== expected.windowId ||
					window.webContents.id !== expected.webContentsId ||
					window.webContents.getURL() !== expected.url
				)
					throw new Error("Native capture refused another window.");
				const contentBounds = window.getContentBounds();
				const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: false });
				if (image.isEmpty()) throw new Error("Native capture is empty.");
				return {
					png: image.toPNG({ scaleFactor: 1 }).toString("base64"),
					imageSize: image.getSize(1),
					contentBounds,
				};
			},
			{ windowId: before.windowId, webContentsId: before.webContentsId, url: before.url },
		);
		if (shot.png.length > 24 * 1024 * 1024) throw new Error("Native capture exceeds its bound.");
		const png = Buffer.from(shot.png, "base64");
		const pixelSize = readPngSize(png);
		await writeFile(join(fixture.manifest.artifactDir, file), png);
		const cssViewport = await page.evaluate(() => ({
			width: Reflect.get(globalThis, "innerWidth") as number,
			height: Reflect.get(globalThis, "innerHeight") as number,
		}));
		const after = await capture();
		assertMode(config.showWindow === true, after);
		assertStable(before, after);
		return {
			file,
			backend: "webContents.capturePage",
			contentBounds: shot.contentBounds,
			imageSize: shot.imageSize,
			pixelSize,
			cssViewport,
			zoom: before.zoom,
		};
	};
	let initialCapture: NativeCaptureEvidence;
	try {
		initialCapture = await nativeScreenshot();
		await writeFile(
			join(fixture.manifest.artifactDir, "native-initial-capture.json"),
			JSON.stringify(initialCapture, null, 2),
		);
	} catch {
		throw new DesktopNativeExperienceError("initial", true);
	}
	const proof = await proveNativeExperience(config.showWindow === true, {
		capture,
		closeWindow: () => mutateWindow("close"),
		activateWindow: async () => {
			if (config.showWindow !== true) throw new Error("Hidden native experience cannot activate a window.");
			await driver.app.evaluate(({ app }: NativeEvaluationModule) => {
				app.emit("activate");
			});
		},
		waitForWindow: async (visible, focused) => {
			for (let attempt = 0; attempt < 50; attempt += 1) {
				const state = await capture();
				if (state.visible === visible && state.focused === focused) return;
				await page.waitForTimeout(100);
			}
			throw new Error("Native visibility/focus transition timed out.");
		},
		configure: (bounds, zoom) => mutateWindow("configure", { bounds, zoom }),
		restore: (state) => mutateWindow("restore", state),
		exercise: async (zoom, size) => {
			const prefix = `native-zoom-${zoom === 1.25 ? "125" : "150"}`;
			const settings = page.getByRole("button", { name: "Settings", exact: true });
			const create = page.getByRole("button", { name: "Create task", exact: true }).first();
			const actions: NativeActionEvidence[] = [];
			const captures: NativeCaptureEvidence[] = [];
			const screenshots = [`${prefix}-board.png`, `${prefix}-settings.png`];
			let step: NativeStep = "board_capture";
			const record = () =>
				writeFile(
					join(fixture.manifest.artifactDir, `${prefix}-checks.json`),
					JSON.stringify({ step, zoom, size, actions, captures }, null, 2),
				);
			const check = async (name: NativeActionName, action: Locator) => {
				const evidence = await actionEvidence(name, action);
				actions.push(evidence);
				await record();
				assertNativeAction(evidence, step);
			};
			try {
				await page.waitForTimeout(200);
				captures.push(await nativeScreenshot(screenshots[0] ?? ""));
				await record();
				step = "board_actions";
				await check("Settings", settings);
				await check("Create task", create);
				step = "settings_enter";
				await record();
				await settings.focus();
				await page.keyboard.press("Enter");
				const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
				try {
					step = "settings_wait";
					await record();
					await dialog.waitFor({ state: "visible" });
					if ((await dialog.count()) !== 1) throw new NativeVisualFailure({ step });
					step = "settings_tab";
					await record();
					await page.keyboard.press("Tab");
					if (!(await dialog.evaluate((element) => element.contains(element.ownerDocument.activeElement))))
						throw new NativeVisualFailure({ step });
					step = "settings_capture";
					await page.waitForTimeout(200);
					captures.push(await nativeScreenshot(screenshots[1] ?? ""));
					await writeFile(
						join(fixture.manifest.artifactDir, `${prefix}-settings.aria.txt`),
						await dialog.ariaSnapshot(),
						"utf8",
					);
					await record();
					step = "settings_actions";
					await check("Settings Cancel", dialog.getByRole("button", { name: "Cancel", exact: true }));
					await check("Settings Save", dialog.getByRole("button", { name: "Save", exact: true }));
				} finally {
					await page.keyboard.press("Escape");
				}
				step = "settings_escape";
				await record();
				await dialog.waitFor({ state: "hidden" });
				step = "create_enter";
				await record();
				await create.focus();
				await page.keyboard.press("Enter");
				const newTask = page
					.getByRole("dialog")
					.filter({ has: page.getByRole("heading", { name: "New task", exact: true }) });
				try {
					step = "create_wait";
					await record();
					await newTask.waitFor({ state: "visible" });
					if ((await newTask.count()) !== 1) throw new NativeVisualFailure({ step });
				} finally {
					await page.keyboard.press("Escape");
				}
				step = "create_escape";
				await record();
				await newTask.waitFor({ state: "hidden" });
				step = "checkpoint";
				await record();
				await driver.inspect(prefix);
				return {
					zoom,
					size,
					actions,
					screenshots,
					captures,
					keyboard: {
						settingsEnter: true,
						settingsTabContained: true,
						settingsEscape: true,
						createEnter: true,
						createEscape: true,
					},
				};
			} catch (error) {
				const diagnostic = error instanceof NativeVisualFailure ? error.diagnostic : { step };
				await writeFile(
					join(fixture.manifest.artifactDir, `${prefix}-failure.json`),
					JSON.stringify({ diagnostic, zoom, size, actions, captures }, null, 2),
				);
				throw new NativeVisualFailure(diagnostic);
			}
		},
	});
	return { ...proof, initialCapture };
}

export const _testing = {
	proveNativeExperience,
	assertActionBounds,
	assertNativeAction,
	readPngSize,
	NativeVisualFailure,
};
