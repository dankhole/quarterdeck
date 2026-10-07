import { createServer as createNetServer, Socket as NetSocket } from "node:net";
import { Command, Option } from "commander";
import ora, { type Ora } from "ora";
import packageJson from "../package.json" with { type: "json" };
import { registerBackupCommand } from "./commands/backup";
import { registerDesktopCommand } from "./commands/desktop.js";
import { registerDiagnosticsCommand } from "./commands/diagnostics";
import { registerHooksCommand } from "./commands/hooks";
import { registerStatuslineCommand } from "./commands/statusline";
import {
	DEFAULT_QUARTERDECK_RUNTIME_PORT,
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimeOrigin,
	installGracefulShutdownHandlers,
	parseRuntimePort,
	setQuarterdeckRuntimeHost,
	setQuarterdeckRuntimePort,
} from "./core";
import { launchDesktop } from "./desktop-launcher.js";
import { createDesktopRuntimeDiagnosticsIngestor } from "./diagnostics/desktop-diagnostics.js";
import { DesktopRuntimeChannel } from "./server/desktop-runtime-channel";
import { classifyDesktopStartupFailure } from "./server/desktop-startup-failure.js";
import { createRuntimeHostIntegrations } from "./server/runtime-host-integrations";
import { startAdmittedRuntime } from "./server/runtime-launch";
import { notifyAboutAvailableUpdate } from "./update-notification";

interface CliOptions {
	noOpen: boolean;
	nativeUiAvailable: boolean;
	hostSimulationConfigPath: string | null;
	skipShutdownCleanup: boolean;
	host: string | null;
	port: { mode: "fixed"; value: number } | { mode: "auto" } | null;
}

const QUARTERDECK_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

function parseCliPortValue(rawValue: string): { mode: "fixed"; value: number } | { mode: "auto" } {
	const normalized = rawValue.trim().toLowerCase();
	if (!normalized) {
		throw new Error("Missing value for --port.");
	}
	if (normalized === "auto") {
		return { mode: "auto" };
	}
	try {
		return { mode: "fixed", value: parseRuntimePort(normalized) };
	} catch {
		throw new Error(`Invalid port value: ${rawValue}. Expected an integer from 1-65535 or "auto".`);
	}
}

interface RootCommandOptions {
	desktop?: boolean;
	browser?: boolean;
	host?: string;
	port?: { mode: "fixed"; value: number } | { mode: "auto" };
	open?: boolean;
	nativeUi?: boolean;
	simulateHostIntegrations?: string;
	skipShutdownCleanup?: boolean;
}

type ShutdownIndicatorResult = "done" | "interrupted" | "failed";

interface ShutdownIndicator {
	start: () => void;
	stop: (result?: ShutdownIndicatorResult) => void;
}

/**
 * Decide whether this CLI invocation should auto-open a browser tab.
 *
 * This uses a positive allowlist for app-launch shapes like `quarterdeck` and
 * `quarterdeck --port 3500`. Any subcommand or
 * unexpected argument is treated as a command-style invocation instead.
 */
function shouldAutoOpenBrowserTabForInvocation(argv: string[]): boolean {
	const launchFlags = new Set([
		"--browser",
		"--open",
		"--no-open",
		"--no-native-ui",
		"--no-update-notifier",
		"--skip-shutdown-cleanup",
	]);
	const launchOptionsWithValues = new Set(["--host", "--port", "--simulate-host-integrations"]);

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (!arg.startsWith("-")) {
			return false;
		}
		if (launchFlags.has(arg)) {
			continue;
		}
		const optionName = arg.split("=", 1)[0] ?? arg;
		if (!launchOptionsWithValues.has(optionName)) {
			return false;
		}
		if (arg.includes("=")) {
			continue;
		}
		const optionValue = argv[index + 1];
		if (!optionValue) {
			return false;
		}
		index += 1;
	}

	return true;
}

function createShutdownIndicator(stream: NodeJS.WriteStream = process.stderr): ShutdownIndicator {
	let spinner: Ora | null = null;
	let running = false;

	return {
		start() {
			if (running) {
				return;
			}
			running = true;
			if (!stream.isTTY) {
				stream.write("Cleaning up...\n");
				return;
			}
			spinner = ora({
				text: "Cleaning up...",
				stream,
			}).start();
		},
		stop(result = "done") {
			if (!running) {
				return;
			}
			running = false;
			if (spinner) {
				if (result === "done") {
					spinner.succeed("Cleaning up... done");
				} else if (result === "failed") {
					spinner.fail("Cleaning up... failed");
				} else {
					spinner.warn("Cleaning up... interrupted");
				}
				spinner = null;
				return;
			}

			const suffix = result === "done" ? "done" : result === "interrupted" ? "interrupted" : "failed";
			stream.write(`Cleanup ${suffix}.\n`);
		},
	};
}

async function isPortAvailable(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const probe = createNetServer();
		probe.once("error", () => {
			resolve(false);
		});
		probe.listen(port, getQuarterdeckRuntimeHost(), () => {
			probe.close(() => {
				resolve(true);
			});
		});
	});
}

async function findAvailableRuntimePort(startPort: number): Promise<number> {
	for (let candidate = startPort; candidate <= 65535; candidate += 1) {
		if (await isPortAvailable(candidate)) {
			return candidate;
		}
	}
	throw new Error("No available runtime port found.");
}

async function applyRuntimePortOption(portOption: CliOptions["port"]): Promise<number | null> {
	if (!portOption) {
		return null;
	}
	if (portOption.mode === "fixed") {
		setQuarterdeckRuntimePort(portOption.value);
		return portOption.value;
	}
	const autoPort = await findAvailableRuntimePort(DEFAULT_QUARTERDECK_RUNTIME_PORT);
	setQuarterdeckRuntimePort(autoPort);
	return autoPort;
}

function createRuntimeWarnLogger(): (message: string) => void {
	return (message: string): void => {
		console.warn(`[quarterdeck] ${message}`);
	};
}

async function runMainCommand(options: CliOptions, shouldAutoOpenBrowser: boolean): Promise<void> {
	const desktop = process.env.QUARTERDECK_DESKTOP_CHILD === "1" ? new DesktopRuntimeChannel() : null;
	const desktopStartup = desktop ? await desktop.startup : null;
	if (desktop && options.skipShutdownCleanup) throw new Error("Desktop cannot skip shutdown cleanup.");
	if (options.host) setQuarterdeckRuntimeHost(options.host);
	if (desktop) setQuarterdeckRuntimeHost("127.0.0.1");
	const selectedPort = desktop ? null : await applyRuntimePortOption(options.port);
	if (selectedPort !== null) console.log(`Using runtime port ${selectedPort}.`);

	const launch = await startAdmittedRuntime({
		...options,
		quarterdeckVersion: QUARTERDECK_VERSION,
		desktopStartup,
		desktopRequestHostEffect: desktop
			? (action, generation) => desktop.requestHostEffect(action, generation)
			: undefined,
	}).catch(async (error: unknown) => {
		if (desktop) {
			const failure = classifyDesktopStartupFailure(error);
			await desktop.fail(failure.code, failure.message);
		}
		throw error;
	});
	if (desktop) {
		const diagnostics = launch.runtime ? createDesktopRuntimeDiagnosticsIngestor(launch.runtime.diagnostics) : null;
		if (diagnostics) desktop.setDiagnosticsHandler(diagnostics.ingest);
		desktop.setShutdownHandler(async (waitForCompletion) => {
			const outcome = await launch.shutdown(waitForCompletion);
			if (outcome.safeToExit) diagnostics?.dispose();
			return outcome;
		});
		desktop.setControlHandler(async (method) =>
			method === "create-browser-launch"
				? { method, url: await launch.createBrowserUrl() }
				: {
						method,
						owned: launch.kind === "owned",
						...(launch.runtime?.getQuitSummary() ?? { liveProcessCount: 0, pendingLaunches: false }),
					},
		);
		try {
			await desktop.ready(launch.ready);
		} catch (error) {
			// A parent can disappear while startup is constructing owners. Never let
			// the top-level error exit race their shutdown writes or process cleanup.
			await launch.shutdown(true);
			throw error;
		}
	} else {
		console.log(`Quarterdeck ${launch.kind === "attached" ? "already " : ""}running at ${launch.url}`);
		const browserUrl = await launch.createBrowserUrl();
		if (!options.noOpen && shouldAutoOpenBrowser) {
			if (launch.kind === "attached" && options.hostSimulationConfigPath) {
				// The owner's simulator owns its ledger. Loading it again would reset
				// that evidence and create a second independent sequence writer.
				console.warn("Simulated browser launch is unavailable while attaching; use the Browser URL below.");
			} else {
				const hostIntegrations =
					launch.runtime?.hostIntegrations ??
					createRuntimeHostIntegrations({ capabilities: launch.capabilities, warn: createRuntimeWarnLogger() });
				const result = await hostIntegrations.openExternalUrl(browserUrl);
				if (!result.ok) console.warn(`Could not open browser automatically: ${result.error}`);
				else console.log("Browser launcher accepted the Quarterdeck URL.");
			}
		}
		// This capability is single use, expires quickly, and redirects to a clean URL.
		console.log(`Browser URL: ${browserUrl}`);
	}
	if (launch.kind === "attached") return;
	if (!desktop) console.log("Press Ctrl+C to stop.");

	let isShuttingDown = false;
	const shutdownIndicator = createShutdownIndicator();
	const shutdownController = installGracefulShutdownHandlers({
		process,
		delayMs: process.platform === "win32" ? 8_000 : 10_000,
		exit: (code) => process.exit(code),
		onShutdown: async () => {
			isShuttingDown = true;
			shutdownIndicator.start();
			try {
				const outcome = await launch.shutdown(true);
				if (!outcome.safeToExit) throw new Error("Runtime cleanup could not confirm quiescence.");
				shutdownIndicator.stop("done");
			} catch (error) {
				shutdownIndicator.stop("failed");
				throw error;
			}
		},
		onShutdownError: () => console.error("Shutdown could not complete safely."),
		onTimeout: (delayMs) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit after shutdown timeout (${delayMs}ms).`);
		},
		onSecondSignal: (signal) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit on second signal: ${signal}`);
		},
	});
	// Desktop uses its authenticated private IPC disconnect; ordinary piped CLI
	// launchers retain the existing stdin-parent lifetime contract.
	if (!desktop && process.stdin instanceof NetSocket && !process.stdin.isTTY) {
		process.stdin.resume();
		process.stdin.on("end", () => {
			if (!isShuttingDown) shutdownController.requestShutdown(process.platform === "win32" ? "SIGTERM" : "SIGHUP");
		});
	}
}

function createProgram(invocationArgs: string[]): Command {
	const shouldAutoOpenBrowser = shouldAutoOpenBrowserTabForInvocation(invocationArgs);
	const program = new Command();
	program
		.name("quarterdeck")
		.description("Local orchestration board for coding agents.")
		.version(QUARTERDECK_VERSION, "-v, --version", "Output the version number")
		.addOption(new Option("--browser", "Open browser mode (the default).").conflicts("desktop"))
		.addOption(
			new Option("--desktop", "Install if needed and open the optional macOS app.").conflicts([
				"browser",
				"host",
				"port",
				"open",
				"nativeUi",
				"skipShutdownCleanup",
				"simulateHostIntegrations",
			]),
		)
		.option("--host <ip>", "Host IP to bind the server to (default: 127.0.0.1).")
		.option("--port <number|auto>", "Runtime port (1-65535) or auto.", parseCliPortValue)
		.option("--no-open", "Do not open browser automatically.")
		.option("--no-native-ui", "Disable integrations that launch or interact with host-native UI.")
		.option("--no-update-notifier", "Disable the periodic npm update notification.")
		.option("--skip-shutdown-cleanup", "Skip graceful shutdown cleanup (session marking, orphan process cleanup).")
		.showHelpAfterError()
		.addHelpText("after", `\nRuntime URL: ${getQuarterdeckRuntimeOrigin()}`);

	program.addOption(
		new Option(
			"--simulate-host-integrations <config-path>",
			"Use injected host-integration simulation policy.",
		).hideHelp(),
	);

	registerHooksCommand(program);
	registerStatuslineCommand(program);
	registerBackupCommand(program);
	registerDiagnosticsCommand(program);
	registerDesktopCommand(program, QUARTERDECK_VERSION);
	program.hook("preAction", (_command, actionCommand) => {
		const options = program.opts<RootCommandOptions>();
		if (actionCommand !== program && (options.desktop || options.browser)) {
			throw new Error("--desktop and --browser select launch modes and cannot be combined with subcommands.");
		}
	});

	program.action(async (options: RootCommandOptions) => {
		if (options.desktop) {
			await launchDesktop(QUARTERDECK_VERSION);
			return;
		}
		if (options.simulateHostIntegrations && options.nativeUi !== false) {
			throw new Error("--simulate-host-integrations requires --no-native-ui.");
		}
		if (process.env.QUARTERDECK_DESKTOP_CHILD !== "1") notifyAboutAvailableUpdate();
		await runMainCommand(
			{
				host: options.host ?? null,
				port: options.port ?? null,
				noOpen: options.open === false,
				nativeUiAvailable: options.nativeUi !== false,
				hostSimulationConfigPath: options.simulateHostIntegrations ?? null,
				skipShutdownCleanup: options.skipShutdownCleanup === true,
			},
			shouldAutoOpenBrowser,
		);
	});

	return program;
}

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	const program = createProgram(argv);
	await program.parseAsync(argv, { from: "user" });
	if (!shouldAutoOpenBrowserTabForInvocation(argv)) {
		process.exit(process.exitCode ?? 0);
	}
}

void run().catch(async (error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to start Quarterdeck: ${message}`);
	process.exit(1);
});
