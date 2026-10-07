import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	app,
	autoUpdater,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	Notification,
	powerMonitor,
	protocol,
	session,
	shell,
} from "electron";
import originalFs from "original-fs";
import type { DesktopDiagnosticEvent, DesktopDiagnosticState } from "../../src/core/api/desktop-diagnostics.js";
import type { DesktopStartupFailureMessage } from "../../src/core/api/desktop-runtime-protocol.js";
import type { RuntimeShutdownOutcome } from "../../src/core/api/runtime-shutdown.js";
import { type DesktopLaunchAppIdentity, readDesktopLaunchRequest } from "../../src/shared/desktop-launch-contract.js";
import { admittedBrowserLaunch } from "./browser-launch.js";
import { createDesktopDiagnostics, type DesktopDiagnostics } from "./desktop-diagnostics.js";
import { DesktopDialogs } from "./desktop-dialogs.js";
import { DesktopHostEffectDispatcher } from "./desktop-host-effects.js";
import { readDesktopLaunchAppIdentity } from "./desktop-launch-identity.js";
import { DesktopLaunchRequests, desktopLaunchRefusal } from "./desktop-launch-requests.js";
import { navigateDesktopDocument } from "./desktop-navigation.js";
import { resolveDesktopFrontendPreflightReason } from "./desktop-preflight-reason.js";
import { verifyDesktopUpdateEligibility } from "./desktop-update-proof.js";
import { DesktopUpdates } from "./desktop-updates.js";
import { createDesktopWindow, restoreDesktopWindow } from "./desktop-window.js";
import { createDesktopDiagnosticExporter } from "./diagnostic-export.js";
import { installEditorDraftSave } from "./editor-draft-save.js";
import { DesktopEnvironmentController, type DesktopEnvironmentRefreshResult } from "./environment-controller.js";
import { applyDesktopExecutableDirectories, readDesktopEnvironmentPreferences } from "./environment-preferences.js";
import { recoverDesktopAfterInstallerFailure } from "./installer-recovery.js";
import { type DesktopLaunchConfig, readDesktopLaunchConfig, validateDesktopLaunchRequest } from "./launch-config.js";
import { createDesktopLaunchEnvironmentResolver, type DesktopLaunchEnvironmentResult } from "./launch-environment.js";
import { desktopMenuTemplate } from "./native-menus.js";
import { DesktopNotificationSubscription } from "./notification-subscription.js";
import { proxyRuntimeRequest } from "./protocol-proxy.js";
import { DesktopQuitCoordinator, type DesktopQuitReason } from "./quit-coordinator.js";
import {
	type ApprovedRenderer,
	DESKTOP_BOOTSTRAP_CHANNEL,
	installRendererAdmission,
	isBootstrapPayload,
	isBootstrapSender,
} from "./renderer-admission.js";
import { DesktopRendererCommands } from "./renderer-commands.js";
import { type RuntimeBundle, readRuntimeBundle } from "./runtime-bundle.js";
import { RuntimeSelection } from "./runtime-selection.js";
import {
	RuntimeStartupError,
	RuntimeSupervisor,
	type RuntimeSupervisorEvidence,
	type SupervisedRuntime,
} from "./runtime-supervisor.js";
import { DESKTOP_ORIGIN, desktopPartition, desktopUrl, isProductPage } from "./security-policy.js";
import { type DesktopSurface, startupSurface } from "./startup-surface.js";
import { installWindowState, readWindowState, restoreWindowState } from "./window-state.js";

// Electron's ordinary fs treats app.asar as a virtual directory; package identity
// must read the archive's actual bytes without changing process-wide ASAR policy.
const readDesktopArchive = promisify(originalFs.readFile);

protocol.registerSchemesAsPrivileged([
	{
		scheme: "app",
		privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
	},
]);

async function launchDesktop(launch: DesktopLaunchConfig, appIdentity: DesktopLaunchAppIdentity | null): Promise<void> {
	const showWindow = launch.lab?.showWindow ?? true;
	if (launch.synthetic) {
		// Electron 44.4+ uses this same Chromium switch for its own isolated macOS app tests.
		app.commandLine.appendSwitch("use-mock-keychain");
		if (!showWindow && process.platform === "darwin") app.setActivationPolicy("accessory");
	}
	app.setPath("userData", launch.userDataPath);
	app.setPath("sessionData", launch.userDataPath);
	if (!app.requestSingleInstanceLock({ quarterdeckLaunch: launch.request })) {
		app.quit();
		return;
	}
	let renderer: ApprovedRenderer | null = null;
	let supervisor: RuntimeSupervisor | null = null;
	let updates: DesktopUpdates | null = null;
	let commands: DesktopRendererCommands | null = null;
	let coordinator: DesktopQuitCoordinator | null = null;
	let diagnostics: DesktopDiagnostics | null = null;
	let notifications: DesktopNotificationSubscription | null = null;
	let exporter: (() => Promise<void>) | null = null;
	let runtimeIdentity: SupervisedRuntime | null = null;
	let bundle: RuntimeBundle | null = null;
	let environment: DesktopLaunchEnvironmentResult | null = null;
	let appliedDirectories: string[] = [];
	let currentProjectId: string | null = null;
	let runtimeEvidence: RuntimeSupervisorEvidence = {
		phase: "stopped",
		helperPid: null,
		generation: null,
		runtimeOrigin: null,
	};
	let surface: DesktopSurface | "product" = "starting";
	let starting = false;
	let stopping = false;
	let navigating = false;
	let reloading = false;
	let refreshing = false;
	let documentCommitEpoch = 0;
	let shutdownConfirmed = false;
	let loadedGeneration: string | null = null;
	let startupFailureCode: DesktopStartupFailureMessage["code"] = "startup_failed";
	let preparation: Promise<void> | null = null;
	let environmentCleanupUnconfirmed = false;
	const nativeNotifications = !launch.synthetic && Notification.isSupported();
	const selection = new RuntimeSelection({ desktop: true, nativeDialogs: !launch.synthetic, nativeNotifications });
	const getWindow = (): BrowserWindow | null =>
		renderer && !renderer.contents.isDestroyed() ? BrowserWindow.fromWebContents(renderer.contents) : null;
	const record = (event: DesktopDiagnosticEvent): void => {
		diagnostics?.record(event);
	};
	const getDiagnostics = (): DesktopDiagnostics | null => diagnostics;
	const getEnvironment = (): DesktopLaunchEnvironmentResult | null => environment;
	const getRuntimeIdentity = (): SupervisedRuntime | null => runtimeIdentity;
	const flushEvidence = async (): Promise<void> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				getDiagnostics()
					?.flush()
					.catch(() => undefined),
				new Promise<void>((done) => {
					timer = setTimeout(done, 2000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	const restoreWindow = (): void => {
		if (showWindow) {
			restoreDesktopWindow(renderer);
			record({ kind: "lifecycle", action: "window_restored" });
		}
	};
	const dialogs = new DesktopDialogs(getWindow, launch.synthetic);
	const hostEffects = new DesktopHostEffectDispatcher({
		getIdentity: () => supervisor?.hostEffectIdentity() ?? null,
		getParentWindow: getWindow,
	});
	const productReady = (): boolean =>
		Boolean(
			renderer?.documentId &&
				loadedGeneration &&
				!renderer.contents.isDestroyed() &&
				isProductPage(renderer.contents.getURL()) &&
				!starting &&
				!stopping &&
				!navigating &&
				!reloading &&
				!refreshing &&
				!shutdownConfirmed,
		);
	const connectedProduct = (): boolean => productReady() && renderer?.generation === selection.get()?.generation;
	const launchIdentity = appIdentity ? { ...appIdentity, stateHome: launch.stateHome } : null;
	const launchRequests = new DesktopLaunchRequests(
		launchIdentity,
		(projectPath) => {
			const runtime = selection.get();
			const availability = commands?.availability();
			if (connectedProduct() && availability?.runtimeConnected && availability.projectLaunchReady === undefined)
				return "unsupported";
			return Boolean(
				runtime &&
					connectedProduct() &&
					commands?.openProject({ runtimeGeneration: runtime.generation, projectPath }),
			);
		},
		(message) => dialog.showErrorBox("Project launch refused", message),
	);
	if (launch.request) launchRequests.accept(launch.request);
	const environmentController = new DesktopEnvironmentController({
		userDataPath: launch.userDataPath,
		getStatus: () => ({
			ownership: supervisor?.isRunning() ? (runtimeIdentity?.ownership ?? "none") : "none",
			source: environment?.source ?? "unresolved",
			failureReason: environment?.source === "fallback" ? environment.failureReason : undefined,
			appliedDirectories,
		}),
		showMessage: (options) => dialogs.message(options),
		showFolders: (options) => dialogs.chooseFolders(options),
		requestRefresh: () => refreshEnvironment(),
	});
	const rebuildMenu = (): void => {
		Menu.setApplicationMenu(
			Menu.buildFromTemplate(
				desktopMenuTemplate({
					appName: app.getName(),
					productReady: productReady(),
					availableCommands: commands?.availability()?.commands ?? [],
					runtimeConnected:
						connectedProduct() &&
						commands?.availability()?.runtimeConnected === true &&
						(commands?.availability()?.commands.length ?? 0) > 0,
					updatesAvailable: updates?.snapshot().phase !== "disabled" && updates !== null,
					updatePending: updates?.snapshot().pending ?? false,
					dispatch: (command) => {
						if (productReady()) commands?.dispatch(command);
					},
					openInBrowser: () => {
						void openInBrowser();
					},
					checkForUpdates: () => {
						void updates?.checkForUpdates();
					},
					restartToUpdate: () => {
						void updates?.restartToUpdate();
					},
					reloadWindow: () => {
						void reloadWindow();
					},
					runtimeFailed:
						surface === "runtime_failed" && !starting && !stopping && !navigating && !reloading && !refreshing,
					restartRuntime: () => {
						void startRuntime();
					},
					environmentSetup:
						!starting && !stopping && !navigating && !reloading && !refreshing && !shutdownConfirmed
							? () => {
									void environmentController.open();
								}
							: undefined,
					exportDiagnostics: exporter
						? () => {
								void exporter?.();
							}
						: undefined,
				}),
			),
		);
	};
	const clearRuntime = (): void => {
		diagnostics?.disconnect();
		notifications?.stop();
		notifications = null;
		selection.clear();
		currentProjectId = null;
	};
	const navigate = async (url: string, nextSurface?: DesktopSurface): Promise<void> => {
		const current = renderer;
		if (!current || current.contents.isDestroyed() || navigating)
			throw new Error("Desktop navigation is unavailable.");
		const previous = {
			generation: current.generation,
			documentId: current.documentId,
			loadedGeneration,
			surface,
			currentProjectId,
			commitEpoch: documentCommitEpoch,
		};
		let restored = false;
		navigating = true;
		if (nextSurface) surface = nextSurface;
		rebuildMenu();
		try {
			await navigateDesktopDocument({
				load: () => current.contents.loadURL(url),
				stop: () => current.contents.stop(),
				hasCommitted: () =>
					current !== renderer || current.contents.isDestroyed() || documentCommitEpoch !== previous.commitEpoch,
				restoreSurvivingDocument: () => {
					current.generation = previous.generation;
					current.documentId = previous.documentId;
					loadedGeneration = previous.loadedGeneration;
					surface =
						previous.loadedGeneration && selection.get()?.generation !== previous.generation
							? "runtime_failed"
							: previous.surface;
					currentProjectId = previous.currentProjectId;
					restored = true;
				},
				releaseTransition: () => commands?.releasePreflight(),
			});
		} catch {
			if (!restored) {
				commands?.clearDocument();
				commands?.forgetRetiredNavigation();
				if (renderer === current) {
					current.generation = null;
					current.documentId = null;
					loadedGeneration = null;
					currentProjectId = null;
				}
			}
			throw new Error("Desktop navigation did not complete.");
		} finally {
			navigating = false;
			rebuildMenu();
		}
	};
	const showSurface = async (next: DesktopSurface): Promise<void> => {
		if (renderer && !renderer.contents.isDestroyed()) {
			await navigate(`${DESKTOP_ORIGIN}/__desktop/${next === "starting" ? "startup" : "error"}`, next);
		} else surface = next;
		record({ kind: "lifecycle", action: "surface_changed", surface: next });
		rebuildMenu();
	};
	const loadProduct = async (): Promise<void> => {
		const runtime = selection.get();
		if (!renderer || renderer.contents.isDestroyed() || !runtime || stopping || shutdownConfirmed) return;
		await navigate(`${DESKTOP_ORIGIN}/`);
		if (runtime !== selection.get() || renderer.contents.isDestroyed()) return;
		loadedGeneration = runtime.generation;
		surface = "product";
		record({ kind: "lifecycle", action: "surface_changed", surface });
		rebuildMenu();
	};
	const reloadWindow = async (): Promise<void> => {
		if (!connectedProduct() || navigating || reloading || refreshing || coordinator?.isPending()) return;
		const runtime = selection.get();
		reloading = true;
		rebuildMenu();
		try {
			const preflight = await commands?.requestPreflight("reload", true, "navigation");
			if (
				preflight?.decision === "ready" &&
				commands?.isSealValid(preflight) &&
				runtime === selection.get() &&
				!stopping &&
				!shutdownConfirmed
			)
				await loadProduct();
		} catch {
			if (!loadedGeneration && !stopping && !shutdownConfirmed)
				await showSurface("renderer_failed").catch(() => undefined);
		} finally {
			commands?.releasePreflight();
			reloading = false;
			rebuildMenu();
		}
	};
	const openInBrowser = async (): Promise<void> => {
		const runtime = selection.get();
		if (!runtime || !connectedProduct() || commands?.availability()?.runtimeConnected !== true) return;
		const result = await supervisor?.control("create-browser-launch");
		if (result?.method !== "create-browser-launch" || runtime !== selection.get() || !connectedProduct()) return;
		const destination = admittedBrowserLaunch(result.url, runtime.origin);
		if (destination && !launch.synthetic) await shell.openExternal(destination).catch(() => undefined);
	};
	const evidence = (value: RuntimeSupervisorEvidence): void => {
		runtimeEvidence = value;
		record({
			kind: "generation",
			phase: value.phase,
			helperPid: value.helperPid,
			generation: value.generation,
			ownership: runtimeIdentity?.ownership,
		});
		if (!launch.lab) return;
		const path = launch.lab.processEvidencePath;
		const temporary = `${path}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ version: 1, appPid: process.pid, ...value })}\n`, {
				mode: 0o600,
			});
			renameSync(temporary, path);
		} catch {
			/* Lab evidence never controls runtime ownership. */
		}
	};
	const startRuntime = async (): Promise<void> => {
		if (
			starting ||
			stopping ||
			navigating ||
			reloading ||
			coordinator?.isPending() ||
			shutdownConfirmed ||
			!supervisor ||
			environmentCleanupUnconfirmed
		)
			return;
		starting = true;
		rebuildMenu();
		let reply = null;
		try {
			if (renderer && isProductPage(renderer.contents.getURL()) && loadedGeneration !== null) {
				reply = (await commands?.requestPreflight("reload", true)) ?? null;
				if (reply?.decision !== "ready" || !commands?.isSealValid(reply)) return;
			}
			const outcome = supervisor.isRunning() ? await supervisor.stop() : null;
			if (stopping || shutdownConfirmed) return;
			if (outcome?.status === "incomplete") {
				await dialogs.inform("shutdown_incomplete");
				return;
			}
			// Drain may outlast the bounded seal. This final ACK holds the old document until replacement commits.
			if (reply) {
				reply = (await commands?.requestPreflight("reload", true, "navigation")) ?? null;
				if (reply?.decision !== "ready" || !commands?.isSealValid(reply)) return;
			}
			clearRuntime();
			runtimeIdentity = null;
			await showSurface("starting");
			if (stopping || shutdownConfirmed) return;
			const ready = await supervisor.start();
			if (stopping || shutdownConfirmed) return;
			runtimeIdentity = ready;
			selection.select(ready);
			diagnostics?.connect((payload) => supervisor?.sendDiagnostics(payload) ?? false);
			installNotifications();
			await loadProduct();
			await diagnostics?.markReady();
			record({ kind: "startup", phase: "ready" });
		} catch (error: unknown) {
			startupFailureCode = error instanceof RuntimeStartupError ? error.code : "startup_failed";
			record({
				kind: "startup",
				phase: "failed",
				failureCode:
					startupFailureCode === "incompatible_runtime"
						? "protocol_incompatible"
						: startupFailureCode === "ownership_unavailable"
							? "ownership_unavailable"
							: "helper_failed",
			});
			if (!stopping && !shutdownConfirmed) {
				await diagnostics?.markFailed();
				if (renderer?.documentId && loadedGeneration && isProductPage(renderer.contents.getURL())) {
					surface = "runtime_failed";
					record({ kind: "lifecycle", action: "surface_changed", surface });
				} else await showSurface("startup_failed").catch(() => undefined);
			}
		} finally {
			commands?.releasePreflight();
			starting = false;
			rebuildMenu();
			launchRequests.deliver();
		}
	};
	const createSupervisor = (environmentForHelper: NodeJS.ProcessEnv): RuntimeSupervisor => {
		if (!bundle) throw new Error("Runtime bundle is unavailable.");
		return new RuntimeSupervisor({
			bundle,
			launch,
			environment: environmentForHelper,
			onEvidence: evidence,
			onPrivateMessage: (message, sender) => {
				void hostEffects
					.handleMessage(message, sender)
					.then((result) => {
						if (result && sender.connected) sender.send(result, () => undefined);
					})
					.catch(() => undefined);
			},
			onUnexpectedExit: () => {
				clearRuntime();
				if (stopping || shutdownConfirmed) return;
				if (renderer && isProductPage(renderer.contents.getURL())) {
					surface = "runtime_failed";
					record({ kind: "lifecycle", action: "surface_changed", surface });
					rebuildMenu();
				} else if (!navigating) void showSurface("runtime_failed").catch(() => undefined);
			},
		});
	};
	const installNotifications = (): void => {
		const runtime = selection.get();
		if (!runtime || !bundle) return;
		notifications?.stop();
		const subscription = new DesktopNotificationSubscription({
			runtime,
			buildId: bundle.buildId,
			getFocus: () => ({
				focused: Boolean(
					renderer?.documentId &&
						loadedGeneration === runtime.generation &&
						isProductPage(renderer.contents.getURL()) &&
						getWindow()?.isFocused(),
				),
				currentProjectId,
			}),
			onBadge: (count) => {
				if (!launch.synthetic && process.platform === "darwin") app.dock?.setBadge(count > 0 ? String(count) : "");
			},
			onNotification: (event) => {
				if (!nativeNotifications || runtime !== selection.get()) return;
				const body = {
					permission: "A task needs your input.",
					review: "A task is ready for review.",
					failure: "A task needs attention.",
				}[event.eventType];
				const notification = new Notification({
					title: "Quarterdeck",
					subtitle: event.projectName,
					body,
					silent: event.silent,
				});
				notification.once("click", () => {
					if (runtime !== selection.get() || stopping || shutdownConfirmed) return;
					restoreWindow();
					commands?.notificationTarget({
						runtimeGeneration: runtime.generation,
						...subscription.resolveTarget(event),
					});
				});
				notification.show();
			},
		});
		notifications = subscription;
	};
	const resolveEnvironment = async (): Promise<NodeJS.ProcessEnv> => {
		if (!bundle) throw new Error("Runtime bundle is unavailable.");
		const preferences = await readDesktopEnvironmentPreferences(launch.userDataPath);
		const resolver = createDesktopLaunchEnvironmentResolver({
			nodePath: bundle.nodePath,
			inheritedEnvironment: process.env,
			isolatedLab: launch.synthetic,
		});
		environment = await resolver();
		appliedDirectories = preferences.extraExecutableDirectories;
		environmentCleanupUnconfirmed = environment.source === "fallback" && environment.processCleanup === "unconfirmed";
		record({
			kind: "startup",
			phase: "environment_resolved",
			environmentSource: environment.source,
			failureCode: environment.source === "fallback" ? "environment_fallback" : undefined,
		});
		return applyDesktopExecutableDirectories(environment.environment, bundle.nodePath, appliedDirectories);
	};
	const refreshEnvironment = async (): Promise<DesktopEnvironmentRefreshResult> => {
		if (
			!coordinator ||
			!bundle ||
			starting ||
			stopping ||
			navigating ||
			reloading ||
			refreshing ||
			coordinator.isPending() ||
			shutdownConfirmed ||
			runtimeIdentity?.ownership === "attached"
		)
			return "cancelled";
		refreshing = true;
		rebuildMenu();
		try {
			const result = await coordinator.request("restart");
			if (result.kind !== "clean") return "incomplete";
			if (coordinator.isNormalQuitPending() || shutdownConfirmed) return "cancelled";
			if (loadedGeneration) {
				const finalSeal = await commands?.requestPreflight("reload", true, "navigation");
				if (finalSeal?.decision !== "ready" || !commands?.isSealValid(finalSeal)) return "cancelled";
			}
			clearRuntime();
			runtimeIdentity = null;
			await showSurface("starting");
			commands?.releasePreflight();
			if (stopping || shutdownConfirmed) return "cancelled";
			preparation = (async () => {
				const refreshed = await resolveEnvironment();
				if (!stopping && !shutdownConfirmed && !environmentCleanupUnconfirmed)
					supervisor = createSupervisor(refreshed);
			})();
			await preparation;
			preparation = null;
			if (stopping || shutdownConfirmed) return "cancelled";
			if (environmentCleanupUnconfirmed) {
				startupFailureCode = "recovery_custody_unconfirmed";
				await showSurface("startup_failed");
				return "incomplete";
			}
			await startRuntime();
			return selection.get() ? (getRuntimeIdentity()?.ownership === "owned" ? "refreshed" : "cancelled") : "failed";
		} catch {
			preparation = null;
			if (!stopping && !shutdownConfirmed && !loadedGeneration)
				await showSurface("startup_failed").catch(() => undefined);
			return "failed";
		} finally {
			commands?.releasePreflight();
			refreshing = false;
			rebuildMenu();
		}
	};
	const requestQuit = async (reason: DesktopQuitReason): Promise<boolean> => {
		if (!coordinator) return false;
		// Provisional navigation temporarily clears document authority; no lifecycle action may use that gap.
		if (navigating || reloading || ((refreshing || starting) && loadedGeneration !== null)) {
			await dialogs.inform("frontend_unavailable");
			return false;
		}
		record({ kind: "shutdown", phase: "requested", intent: reason === "restart" ? "retry" : reason });
		const result = await coordinator.request(reason);
		if (result.kind === "cancelled") {
			if (reason === "quit") coordinator.cancelNormalQuit();
			record({ kind: "shutdown", phase: "cancelled", intent: reason === "restart" ? "retry" : reason });
			restoreWindow();
			return false;
		}
		shutdownConfirmed = true;
		clearRuntime();
		rebuildMenu();
		// A forced user Quit is never represented as cleanup success to the updater.
		return reason === "quit" || result.kind === "clean";
	};

	app.on("second-instance", (_event, _args, _cwd, additionalData: unknown) => {
		record({ kind: "lifecycle", action: "second_instance" });
		restoreWindow();
		if (!additionalData || typeof additionalData !== "object" || Array.isArray(additionalData)) return;
		const envelope = additionalData as Record<string, unknown>;
		if (Object.keys(envelope).length !== 1 || envelope.quarterdeckLaunch == null) return;
		void (async () => {
			let refusal = desktopLaunchRefusal(envelope.quarterdeckLaunch, launchIdentity);
			if (!refusal) {
				try {
					refusal = launchRequests.accept(
						await validateDesktopLaunchRequest(envelope.quarterdeckLaunch, launch.lab),
					);
				} catch {
					refusal =
						"The requested project or state home is unavailable. Run quarterdeck --desktop from its repository again.";
				}
			}
			if (refusal)
				await dialogs.message({
					type: "warning",
					buttons: ["OK"],
					message: "Desktop launch refused",
					detail: refusal,
				});
		})().catch(() => undefined);
	});
	app.on("activate", () => {
		record({ kind: "lifecycle", action: "activate" });
		restoreWindow();
	});
	app.on("before-quit", (event) => {
		if (shutdownConfirmed) return;
		event.preventDefault();
		void requestQuit("quit")
			.then((allowed) => {
				if (allowed) app.quit();
			})
			.catch(() => undefined);
	});
	await app.whenReady();
	app.setAboutPanelOptions({
		applicationName: "Quarterdeck",
		applicationVersion: app.getVersion(),
		copyright: "Copyright © 2026 Quarterdeck contributors",
	});
	const partition = desktopPartition(launch.stateHome);
	const desktopSession = session.fromPartition(partition);
	installRendererAdmission(desktopSession, () => renderer, selection);
	desktopSession.protocol.handle("app", async (request) => {
		const url = desktopUrl(request.url);
		if (!url) return new Response("Forbidden", { status: 403 });
		if (url.pathname === "/__desktop/startup" || url.pathname === "/__desktop/error")
			return startupSurface(surface === "product" ? "starting" : surface, startupFailureCode);
		return await proxyRuntimeRequest(request, selection);
	});
	ipcMain.on(DESKTOP_BOOTSTRAP_CHANNEL, (event, payload: unknown) => {
		event.returnValue =
			isBootstrapPayload(payload) &&
			isBootstrapSender(event, renderer, selection) &&
			renderer?.generation &&
			renderer.documentId
				? { bootstrap: selection.bootstrap(renderer.generation), documentId: renderer.documentId }
				: null;
	});
	commands = new DesktopRendererCommands(ipcMain, () => renderer, selection, 5000, {
		onAvailability: () => {
			rebuildMenu();
			launchRequests.deliver();
		},
		onContext: (context) => {
			currentProjectId = context.currentProjectId;
			notifications?.refreshFocus();
		},
	});
	const disposeDraftSave = installEditorDraftSave({
		ipc: ipcMain,
		getRenderer: () => renderer,
		choosePath: (request) => dialogs.chooseDraftPath(request),
	});
	const createWindow = (): void => {
		renderer = createDesktopWindow({
			partition,
			preloadPath: join(import.meta.dirname, "preload.cjs"),
			isSynthetic: launch.synthetic,
			showWindow,
			isQuitting: () => shutdownConfirmed,
			onSurfaceAction: (action) => {
				if (!renderer || !desktopUrl(renderer.contents.getURL())?.pathname.startsWith("/__desktop/")) return;
				if (
					action === "reload" &&
					surface === "renderer_failed" &&
					!navigating &&
					!starting &&
					!stopping &&
					!coordinator?.isPending()
				)
					void loadProduct().catch(() => undefined);
				if (action === "retry" && (surface === "runtime_failed" || surface === "startup_failed"))
					void startRuntime();
			},
			onDocumentNavigation: () => {
				void reloadWindow();
			},
			onRendererFailed: () => {
				record({ kind: "lifecycle", action: "renderer_failed" });
				// A crash ends the old document's lifetime even when WebContents survives.
				documentCommitEpoch += 1;
				commands?.clearDocument();
				commands?.forgetRetiredNavigation();
				if (renderer) {
					renderer.generation = null;
					renderer.documentId = null;
				}
				loadedGeneration = null;
				currentProjectId = null;
				surface = "renderer_failed";
				if (navigating) {
					try {
						renderer?.contents.stop();
					} catch {
						/* A destroyed renderer has no live navigation. */
					}
				} else void showSurface("renderer_failed").catch(() => undefined);
			},
		});
		renderer.contents.on("did-start-navigation", (event) => {
			if (!event.isMainFrame || event.isSameDocument || !renderer) return;
			commands?.clearDocument();
			renderer.generation = null;
			renderer.documentId = null;
			loadedGeneration = null;
			currentProjectId = null;
			const runtime = selection.get();
			if (runtime && isProductPage(event.url) && !stopping && !shutdownConfirmed) {
				renderer.generation = runtime.generation;
				renderer.documentId = randomUUID();
			}
		});
		renderer.contents.on("did-navigate", () => {
			documentCommitEpoch += 1;
			commands?.forgetRetiredNavigation();
		});
		renderer.contents.on("did-finish-load", () => {
			if (renderer?.generation && isProductPage(renderer.contents.getURL())) loadedGeneration = renderer.generation;
			rebuildMenu();
			launchRequests.deliver();
		});
		const window = getWindow();
		if (window) {
			const path = join(launch.userDataPath, "window-state.json");
			restoreWindowState(window, readWindowState(path));
			installWindowState(window, path);
			window.on("focus", () => notifications?.refreshFocus());
			window.on("blur", () => notifications?.refreshFocus());
			window.on("hide", () => {
				record({ kind: "lifecycle", action: "window_hidden" });
				notifications?.refreshFocus();
			});
		}
	};
	createWindow();
	coordinator = new DesktopQuitCoordinator({
		needsFrontendPreflight: () => loadedGeneration !== null,
		cleanupState: () =>
			supervisor?.isRunning()
				? runtimeIdentity
					? "running"
					: "not_started"
				: environmentCleanupUnconfirmed
					? "unconfirmed"
					: (supervisor?.exitCleanupState() ?? "not_started"),
		preflight: async (reason, seal) =>
			(await commands?.requestPreflight(
				resolveDesktopFrontendPreflightReason(
					reason,
					environmentCleanupUnconfirmed ? "unconfirmed" : (supervisor?.exitCleanupState() ?? "not_started"),
				),
				seal,
			)) ?? null,
		isSealValid: (response) => commands?.isSealValid(response) ?? false,
		releasePreflight: () => commands?.releasePreflight(),
		getSummary: async () => {
			const result = await supervisor?.control("get-quit-summary");
			return result?.method === "get-quit-summary" ? result : null;
		},
		stop: async () => {
			await preparation;
			const outcome =
				(await supervisor?.stop()) ??
				({ status: "clean", safeToExit: true, safeToReleaseOwnership: true } as const);
			const actual: RuntimeShutdownOutcome =
				outcome.status === "clean" && environmentCleanupUnconfirmed
					? {
							status: "incomplete",
							safeToExit: false,
							safeToReleaseOwnership: false,
							reasons: ["processes_unconfirmed"],
						}
					: outcome;
			record({ kind: "shutdown", phase: actual.status === "clean" ? "completed" : "failed", outcome: actual });
			return actual;
		},
		confirmSessions: (summary, reason) => dialogs.confirmSessions(summary, reason),
		confirmUnconfirmedExit: () => dialogs.confirmUnconfirmedExit(),
		inform: (reason) => dialogs.inform(reason),
		canForceExit: () => updates?.snapshot().pending !== true,
		finalize: async (result, reason) => {
			record({
				kind: "shutdown",
				phase: "completed",
				intent: reason === "restart" ? "retry" : reason,
				exitMode: result.kind === "clean" ? "clean" : "forced_unconfirmed",
			});
			await flushEvidence();
		},
		onStopping: (value) => {
			stopping = value;
			rebuildMenu();
		},
	});
	app.once("will-quit", () => {
		commands?.dispose();
		disposeDraftSave();
		updates?.dispose();
		hostEffects.dispose();
		notifications?.stop();
		void diagnostics?.close();
	});
	powerMonitor.on("suspend", () => record({ kind: "lifecycle", action: "sleep" }));
	powerMonitor.on("resume", () => record({ kind: "lifecycle", action: "wake" }));
	await showSurface("starting");
	if (stopping || shutdownConfirmed) return;
	try {
		preparation = (async () => {
			diagnostics = await createDesktopDiagnostics({
				stateHome: launch.stateHome,
				quarterdeckVersion: app.getVersion(),
				getState: (): DesktopDiagnosticState => ({
					surface,
					quitting: stopping || shutdownConfirmed,
					window: {
						present: getWindow() !== null,
						visible: getWindow()?.isVisible() ?? false,
						focused: getWindow()?.isFocused() ?? false,
					},
					runtime: {
						phase: supervisor ? runtimeEvidence.phase : "not_started",
						helperPid: runtimeEvidence.helperPid,
						generation: runtimeEvidence.generation,
						ownership: runtimeIdentity?.ownership ?? null,
					},
					update: updates?.snapshot() ?? {
						phase: "disabled",
						pending: false,
						reason: launch.synthetic ? "synthetic" : "unsigned",
					},
				}),
			});
			record({ kind: "startup", phase: "configured" });
			record({ kind: "lifecycle", action: "window_created" });
			const exportAction = createDesktopDiagnosticExporter({
				stateHome: launch.stateHome,
				desktopInstanceId: diagnostics.instanceId,
				flushDesktop: () => diagnostics?.flush() ?? Promise.resolve(),
				getRuntime: () => {
					const runtime = selection.get();
					return runtime && runtimeIdentity
						? {
								diagnosticInstanceId: runtimeIdentity.diagnosticInstanceId,
								origin: runtime.origin,
								generation: runtime.generation,
								ownership: runtimeIdentity.ownership,
							}
						: null;
				},
				chooseParentDirectory: async () =>
					(
						await dialogs.chooseFolders({
							title: "Export Quarterdeck diagnostics",
							buttonLabel: "Export Here",
							properties: ["openDirectory", "createDirectory"],
						})
					)?.[0] ?? null,
			});
			exporter = async () => {
				const result = await exportAction();
				if (result.status === "cancelled") return;
				await dialogs.message({
					type: result.status === "exported" ? "info" : "warning",
					buttons: ["OK"],
					message: result.status === "exported" ? "Diagnostics exported" : "Diagnostics could not be exported",
					detail:
						result.status === "exported"
							? `${result.source === "desktop" ? "The bundle contains app evidence; the runtime was unavailable or owned by the CLI." : "The bundle contains the selected runtime and app evidence."}${result.partial ? " Some evidence was unavailable." : ""}\n\n${result.path}`
							: "Choose a writable destination and retry while the app remains open.",
				});
			};
			const resourceRoot = app.isPackaged
				? join(process.resourcesPath, "runtime")
				: resolve(import.meta.dirname, "..", ".stage", process.arch, "runtime");
			bundle = readRuntimeBundle(resourceRoot, app.getVersion(), process.arch);
			record({ kind: "startup", phase: "bundle_validated" });
			const environmentForHelper = await resolveEnvironment();
			if (stopping || shutdownConfirmed || environmentCleanupUnconfirmed) return;
			supervisor = createSupervisor(environmentForHelper);
			const eligibility = await verifyDesktopUpdateEligibility({
				appPath: app.getAppPath().replace(/\/Contents\/Resources\/app\.asar$/u, ""),
				resourceRoot,
				isPackaged: app.isPackaged,
				synthetic: launch.synthetic,
				platform: process.platform,
				bundle,
			});
			if (stopping || shutdownConfirmed) return;
			updates = new DesktopUpdates({
				updater: autoUpdater,
				eligibility,
				preflightAndShutdown: () => requestQuit("update"),
				isNormalQuitPending: () => coordinator?.isNormalQuitPending() ?? false,
				showMessage: (message) => dialogs.showUpdate(message),
				chooseDownloadedUpdate: (message) => dialogs.chooseUpdate(message),
				onStatusChanged: rebuildMenu,
				onEvidence: (status) => record({ kind: "update", status }),
				onRestartFailed: () =>
					recoverDesktopAfterInstallerFailure({
						releaseFrontendSeal: () => commands?.releasePreflight(),
						reopenQuitGate: () => {
							shutdownConfirmed = false;
							stopping = false;
						},
						hasWindow: () => getWindow() !== null,
						createWindow,
						showStoppedSurface: () => showSurface("runtime_failed"),
						markRuntimeStopped: () => {
							surface = "runtime_failed";
							rebuildMenu();
							record({
								kind: "update",
								status: { phase: "downloaded", pending: true, reason: "restart_failed" },
							});
						},
					}),
			});
		})();
		await preparation;
		preparation = null;
		if (stopping || shutdownConfirmed) return;
		if (environmentCleanupUnconfirmed) {
			startupFailureCode = "recovery_custody_unconfirmed";
			await showSurface("startup_failed");
			return;
		}
		await startRuntime();
		if (getEnvironment()?.source === "fallback" && !stopping && !shutdownConfirmed && !launch.synthetic)
			void environmentController.open();
	} catch {
		preparation = null;
		record({ kind: "startup", phase: "failed", failureCode: "bundle_invalid" });
		if (!stopping && !shutdownConfirmed) {
			await getDiagnostics()?.markFailed();
			await showSurface("startup_failed");
		}
	}
}

// Top-level await holds Electron's ready event while canonical profile preparation completes.
// launchDesktop itself reaches app.whenReady without awaiting any further pre-ready operation.
const launchPreparation = await (async () => {
	const request = readDesktopLaunchRequest(process.argv);
	const resourceRoot = app.isPackaged
		? join(process.resourcesPath, "runtime")
		: resolve(import.meta.dirname, "..", ".stage", process.arch, "runtime");
	const appIdentity = app.isPackaged
		? await readDesktopLaunchAppIdentity(
				app.getAppPath(),
				resourceRoot,
				app.getVersion(),
				process.arch,
				readDesktopArchive,
			).catch(() => null)
		: null;
	if (request) {
		const refusal = desktopLaunchRefusal(
			request,
			appIdentity ? { ...appIdentity, stateHome: request.stateHome } : null,
		);
		if (refusal) throw new Error(refusal);
	}
	const launch = await readDesktopLaunchConfig(
		process.env.QUARTERDECK_DESKTOP_LAB_CONFIG,
		app.getPath("userData"),
		request,
	);
	return { launch, appIdentity };
})().catch((error: unknown) => {
	dialog.showErrorBox(
		"Desktop launch refused",
		error instanceof Error &&
			(error.message.startsWith("The running Quarterdeck app") ||
				error.message.startsWith("A different Quarterdeck app"))
			? error.message
			: "Quarterdeck desktop could not validate its launch configuration. Run quarterdeck --desktop again, or reopen the app from Finder.",
	);
	console.error("Quarterdeck desktop could not initialize its launch configuration.");
	app.exit(1);
	return null;
});
if (launchPreparation)
	void launchDesktop(launchPreparation.launch, launchPreparation.appIdentity).catch(() => {
		console.error("Quarterdeck desktop could not initialize.");
		app.exit(1);
	});
