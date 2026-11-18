import { createServer as createNetServer, Socket as NetSocket } from "node:net";
import { Command, Option } from "commander";
import ora, { type Ora } from "ora";
import packageJson from "../package.json" with { type: "json" };
import { registerBackupCommand } from "./commands/backup";
import { registerDesktopCommand } from "./commands/desktop.js";
import { registerDiagnosticsCommand } from "./commands/diagnostics";
import { registerHooksCommand } from "./commands/hooks";
import { registerRecoverCommand } from "./commands/recover.js";
import {
	DEFAULT_QUARTERDECK_RUNTIME_PORT,
	getQuarterdeckRuntimeHost,
	installGracefulShutdownHandlers,
	parseRuntimePort,
	setQuarterdeckRuntimeHost,
	setQuarterdeckRuntimePort,
} from "./core";
import { validateDesktopNativeAdmission } from "./desktop-install/index.js";
import { launchDesktop } from "./desktop-launcher.js";
import { createDesktopRuntimeDiagnosticsIngestor } from "./diagnostics/desktop-diagnostics.js";
import { readLaunchEnvironment } from "./launch-environment.js";
import { resolveInternalRuntimeHost, resolveLaunchPolicy } from "./launch-policy.js";
import { DesktopRuntimeChannel } from "./server/desktop-runtime-channel";
import { classifyDesktopStartupFailure } from "./server/desktop-startup-failure.js";
import { startAdmittedRuntime } from "./server/runtime-launch";

interface CliOptions {
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
	internalRuntime?: boolean;
	host?: string;
	port?: { mode: "fixed"; value: number } | { mode: "auto" };
	nativeUi?: boolean;
	simulateHostIntegrations?: string;
	skipShutdownCleanup?: boolean;
}

type ShutdownIndicatorResult = "done" | "interrupted" | "failed";

interface ShutdownIndicator {
	start: () => void;
	stop: (result?: ShutdownIndicatorResult) => void;
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

async function runMainCommand(options: CliOptions): Promise<void> {
	if (process.env.QUARTERDECK_DESKTOP_CHILD === "1" || process.env.QUARTERDECK_INSTALLATION_LOCK_FD !== undefined) {
		await validateDesktopNativeAdmission({ synthetic: process.env.QUARTERDECK_AGENT_LAB === "1" });
	}
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
		desktop.setShutdownHandler(async () => {
			// Only the admitted runtime's full completion fences and drains writes;
			// a bounded shutdown response must never authorize app abandonment.
			const outcome = await launch.shutdown(true);
			if (outcome.safeToExit) diagnostics?.dispose();
			return { outcome, persistenceSettled: true };
		});
		desktop.setControlHandler(async (method) => ({
			method,
			owned: launch.kind === "owned",
			...(launch.runtime?.getQuitSummary() ?? { liveProcessCount: 0, pendingLaunches: false }),
		}));
		try {
			await desktop.ready(launch.ready);
		} catch (error) {
			// A parent can disappear while startup is constructing owners. Never let
			// the top-level error exit race their shutdown writes or process cleanup.
			await launch.shutdown(true);
			throw error;
		}
	} else {
		console.log(`Quarterdeck internal runtime ${launch.kind === "attached" ? "already " : ""}running.`);
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

function createProgram(): Command {
	const program = new Command();
	program
		.name("quarterdeck")
		.description("Local orchestration board for coding agents.")
		.version(QUARTERDECK_VERSION, "-v, --version", "Output the version number")
		.addOption(
			new Option("--desktop", "Open the installed desktop app.").conflicts([
				"internalRuntime",
				"host",
				"port",
				"nativeUi",
				"skipShutdownCleanup",
				"simulateHostIntegrations",
			]),
		)
		.addOption(new Option("--internal-runtime", "Internal desktop/development runtime entrypoint.").hideHelp())
		.addOption(new Option("--host <ip>", "Internal runtime bind address.").hideHelp())
		.addOption(new Option("--port <number|auto>", "Internal runtime port.").argParser(parseCliPortValue).hideHelp())
		.addOption(new Option("--no-native-ui", "Disable host-native UI effects.").hideHelp())
		.option("--no-update-notifier", "Compatibility option; background update notifications are no longer used.")
		.addOption(new Option("--skip-shutdown-cleanup", "Skip internal runtime shutdown cleanup.").hideHelp())
		.showHelpAfterError();

	program.addOption(
		new Option(
			"--simulate-host-integrations <config-path>",
			"Use injected host-integration simulation policy.",
		).hideHelp(),
	);

	registerHooksCommand(program);
	registerBackupCommand(program);
	registerRecoverCommand(program);
	registerDiagnosticsCommand(program);
	registerDesktopCommand(program, QUARTERDECK_VERSION);
	program.hook("preAction", async (_command, actionCommand) => {
		const options = program.opts<RootCommandOptions>();
		if (actionCommand !== program && (options.desktop || options.internalRuntime)) {
			throw new Error("Launch mode options cannot be combined with subcommands.");
		}
		if (actionCommand.name() === "recover" && process.env.QUARTERDECK_INSTALLATION_LOCK_FD !== undefined) {
			await validateDesktopNativeAdmission({ synthetic: process.env.QUARTERDECK_AGENT_LAB === "1" });
		}
	});

	program.action(async (options: RootCommandOptions) => {
		const policy = resolveLaunchPolicy(
			{
				desktop: options.desktop,
				internalRuntime: options.internalRuntime,
				runtimeFlags:
					options.host !== undefined ||
					options.port !== undefined ||
					process.env.QUARTERDECK_RUNTIME_HOST !== undefined ||
					process.env.QUARTERDECK_RUNTIME_PORT !== undefined ||
					options.nativeUi === false ||
					options.skipShutdownCleanup === true ||
					options.simulateHostIntegrations !== undefined,
			},
			await readLaunchEnvironment(),
		);
		if (policy.mode === "desktop") {
			await launchDesktop(QUARTERDECK_VERSION);
			return;
		}
		if (options.simulateHostIntegrations && options.nativeUi !== false) {
			throw new Error("--simulate-host-integrations requires --no-native-ui.");
		}
		await runMainCommand({
			host: resolveInternalRuntimeHost(options.host ?? process.env.QUARTERDECK_RUNTIME_HOST),
			port: options.port ?? null,
			nativeUiAvailable: options.nativeUi !== false,
			hostSimulationConfigPath: options.simulateHostIntegrations ?? null,
			skipShutdownCleanup: options.skipShutdownCleanup === true,
		});
	});

	return program;
}

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	const program = createProgram();
	await program.parseAsync(argv, { from: "user" });
	if (!program.opts<RootCommandOptions>().internalRuntime) process.exit(process.exitCode ?? 0);
}

void run().catch(async (error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to start Quarterdeck: ${message}`);
	process.exit(1);
});
