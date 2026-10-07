import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	type DesktopDiagnosticsPayload,
	desktopDiagnosticsPayloadSchema,
} from "../../src/core/api/desktop-diagnostics.js";
import {
	type DesktopControlMessage,
	type DesktopControlResultMessage,
	type DesktopReadyMessage,
	type DesktopStartupFailureMessage,
	type DesktopStartupMessage,
	desktopChildMessageSchema,
	QUARTERDECK_DESKTOP_ORIGIN,
	QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION,
} from "../../src/core/api/desktop-runtime-protocol.js";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../../src/core/api/runtime-protocol.js";
import type { RuntimeShutdownOutcome } from "../../src/core/api/runtime-shutdown.js";
import type { DesktopHostEffectIdentity } from "./desktop-host-effects.js";
import type { DesktopRuntimeLaunchConfig } from "./launch-config.js";
import { sanitizeDesktopHelperEnvironment } from "./launch-environment.js";
import type { RuntimeBundle } from "./runtime-bundle.js";
import { runtimeOrigin } from "./security-policy.js";

export interface RuntimeSupervisorEvidence {
	helperPid: number | null;
	phase: "starting" | "ready" | "stopping" | "stopped" | "failed";
	generation: string | null;
	runtimeOrigin: string | null;
}

export interface RuntimeSupervisorOptions {
	bundle: RuntimeBundle;
	launch: DesktopRuntimeLaunchConfig;
	environment: NodeJS.ProcessEnv;
	startupDeadlineMs?: number;
	shutdownDeadlineMs?: number;
	spawnChild?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
	onEvidence: (evidence: RuntimeSupervisorEvidence) => void;
	onUnexpectedExit: () => void;
	onPrivateMessage?: (message: unknown, sender: ChildProcess) => void;
}

interface ChildGeneration {
	child: ChildProcess;
	startupId: string;
	clientToken: string;
	ready: DesktopReadyMessage | null;
	exited: boolean;
	exit: Promise<number | null>;
	shutdown: Promise<RuntimeShutdownOutcome> | null;
	shutdownOutcome: RuntimeShutdownOutcome | null;
	diagnosticsSending: boolean;
	diagnosticsQueued: DesktopDiagnosticsPayload | null;
}

export interface SupervisedRuntime {
	origin: string;
	generation: string;
	clientToken: string;
	ownership: "owned" | "attached";
	instanceId: string;
	diagnosticInstanceId: string | null;
}

const CLEAN: RuntimeShutdownOutcome = { status: "clean", safeToExit: true, safeToReleaseOwnership: true };
const UNCONFIRMED: RuntimeShutdownOutcome = {
	status: "incomplete",
	safeToExit: false,
	safeToReleaseOwnership: false,
	reasons: ["processes_unconfirmed"],
};
const DEADLINE: RuntimeShutdownOutcome = {
	status: "incomplete",
	safeToExit: false,
	safeToReleaseOwnership: false,
	reasons: ["deadline"],
};

export class RuntimeStartupError extends Error {
	constructor(readonly code: DesktopStartupFailureMessage["code"] = "startup_failed") {
		super("The desktop runtime could not become ready.");
	}
}

/** The helper's private IPC is the sole readiness/shutdown authority, never stdout or port occupancy. */
export class RuntimeSupervisor {
	private active: ChildGeneration | null = null;

	constructor(private readonly options: RuntimeSupervisorOptions) {}

	isRunning(): boolean {
		return this.active !== null && !this.active.exited;
	}

	async start(): Promise<SupervisedRuntime> {
		if (this.isRunning()) throw new Error("The desktop helper is already running.");
		const { bundle, launch } = this.options;
		if (launch.synthetic && !launch.hostSimulationConfigPath)
			throw new Error("Synthetic launch requires host simulation.");
		const argumentsForRuntime = [bundle.cliPath, "--no-open", "--host", "127.0.0.1", "--port", "auto"];
		if (launch.synthetic && launch.hostSimulationConfigPath)
			argumentsForRuntime.push("--no-native-ui", "--simulate-host-integrations", launch.hostSimulationConfigPath);
		const environment = sanitizeDesktopHelperEnvironment(this.options.environment, bundle.nodePath);
		delete environment.QUARTERDECK_DESKTOP_LAB_CONFIG;
		delete environment.QUARTERDECK_AGENT_LAB;
		if (launch.synthetic) environment.QUARTERDECK_AGENT_LAB = "1";
		const child = (this.options.spawnChild ?? spawn)(bundle.nodePath, argumentsForRuntime, {
			cwd: launch.projectPath,
			env: {
				...environment,
				QUARTERDECK_STATE_HOME: launch.stateHome,
				QUARTERDECK_DESKTOP_CHILD: "1",
			},
			stdio: ["pipe", "ignore", "ignore", "ipc"],
			detached: false,
		});
		let resolveExit: (code: number | null) => void = () => undefined;
		const current: ChildGeneration = {
			child,
			startupId: randomUUID(),
			clientToken: randomBytes(32).toString("base64url"),
			ready: null,
			exited: false,
			exit: new Promise((resolve) => {
				resolveExit = resolve;
			}),
			shutdown: null,
			shutdownOutcome: null,
			diagnosticsSending: false,
			diagnosticsQueued: null,
		};
		this.active = current;
		child.on("message", (message: unknown) => this.options.onPrivateMessage?.(message, child));
		this.evidence(current, "starting");
		child.once("exit", (code) => {
			current.exited = true;
			resolveExit(code);
			this.evidence(current, code === 0 ? "stopped" : "failed");
			if (current.ready && !current.shutdown && this.active === current) this.options.onUnexpectedExit();
		});
		child.on("error", () => {
			if (!child.pid) {
				current.exited = true;
				resolveExit(null);
			}
		});
		const ready = await new Promise<DesktopReadyMessage>((resolve, reject) => {
			const cleanup = (): void => {
				clearTimeout(timer);
				child.off("message", onMessage);
				child.off("error", onError);
				child.off("exit", onExit);
			};
			const fail = (code: DesktopStartupFailureMessage["code"] = "startup_failed"): void => {
				cleanup();
				reject(new RuntimeStartupError(code));
			};
			const onError = (): void => fail();
			const onExit = (): void => fail();
			const onMessage = (message: unknown): void => {
				const parsed = desktopChildMessageSchema.safeParse(message);
				if (!parsed.success || parsed.data.startupId !== current.startupId) return;
				if (parsed.data.type === "quarterdeck:desktop-failed") {
					fail(parsed.data.code);
					return;
				}
				if (parsed.data.type !== "quarterdeck:desktop-ready") return;
				if (
					parsed.data.browserProtocolVersion !== QUARTERDECK_RUNTIME_PROTOCOL_VERSION ||
					(parsed.data.ownership === "owned" && parsed.data.packageVersion !== bundle.version)
				) {
					fail("incompatible_runtime");
					return;
				}
				try {
					runtimeOrigin(parsed.data.runtimeOrigin);
				} catch {
					fail();
					return;
				}
				cleanup();
				resolve(parsed.data);
			};
			const timer = setTimeout(() => fail(), this.options.startupDeadlineMs ?? 30_000);
			child.on("message", onMessage);
			child.once("error", onError);
			child.once("exit", onExit);
			const startup: DesktopStartupMessage = {
				type: "quarterdeck:desktop-startup",
				protocolVersion: QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION,
				startupId: current.startupId,
				clientToken: current.clientToken,
				allowedOrigins: [QUARTERDECK_DESKTOP_ORIGIN],
			};
			child.send(startup, (error) => {
				if (error) fail();
			});
		}).catch(async (error: unknown) => {
			this.evidence(current, "failed");
			if (!current.exited) await this.stop();
			throw error;
		});
		if (current.exited || current.shutdown || this.active !== current)
			throw new Error("Desktop startup was interrupted.");
		current.ready = ready;
		this.evidence(current, "ready");
		return {
			origin: ready.runtimeOrigin,
			generation: ready.runtimeGeneration,
			clientToken: current.clientToken,
			ownership: ready.ownership,
			instanceId: ready.instanceId,
			diagnosticInstanceId: ready.diagnosticInstanceId,
		};
	}

	stop(): Promise<RuntimeShutdownOutcome> {
		const current = this.active;
		if (!current) return Promise.resolve(CLEAN);
		if (current.shutdown) return current.shutdown;
		if (current.exited)
			return Promise.resolve(!current.child.pid || current.ready?.ownership === "attached" ? CLEAN : UNCONFIRMED);
		this.evidence(current, "stopping");
		current.shutdown = this.requestShutdown(current).then((outcome) => {
			current.shutdownOutcome = outcome;
			if (outcome.status === "incomplete" && !current.exited) current.shutdown = null;
			return outcome;
		});
		return current.shutdown;
	}

	exitCleanupState(): "not_started" | "running" | "clean" | "unconfirmed" {
		const current = this.active;
		if (!current) return "not_started";
		if (!current.exited) return "running";
		if (!current.child.pid || current.ready?.ownership === "attached" || current.shutdownOutcome?.status === "clean")
			return "clean";
		return "unconfirmed";
	}

	hostEffectIdentity(): DesktopHostEffectIdentity | null {
		const current = this.active;
		if (!current?.ready || current.exited) return null;
		return {
			sender: current.child,
			startupId: current.startupId,
			runtimeGeneration: current.ready.runtimeGeneration,
			ownership: current.ready.ownership,
			synthetic: this.options.launch.synthetic,
			stopping: current.shutdown !== null || current.shutdownOutcome !== null,
		};
	}

	/** One in-flight IPC write and one bounded canonical tail; no diagnostics can authorize lifecycle effects. */
	sendDiagnostics(payload: DesktopDiagnosticsPayload): boolean {
		const current = this.active;
		const parsed = desktopDiagnosticsPayloadSchema.safeParse(payload);
		if (!parsed.success || !current?.ready || current.exited || current.shutdown || !current.child.connected)
			return false;
		if (current.diagnosticsSending) {
			const previous = current.diagnosticsQueued;
			current.diagnosticsQueued =
				previous?.desktopInstanceId === parsed.data.desktopInstanceId
					? {
							desktopInstanceId: previous.desktopInstanceId,
							records: [...previous.records, ...parsed.data.records].slice(-100),
						}
					: parsed.data;
			return true;
		}
		current.diagnosticsSending = true;
		try {
			current.child.send(
				{
					type: "quarterdeck:desktop-diagnostics",
					protocolVersion: QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION,
					startupId: current.startupId,
					payload: parsed.data,
				},
				(error) => {
					current.diagnosticsSending = false;
					const queued = current.diagnosticsQueued;
					current.diagnosticsQueued = null;
					if (!error && queued && this.active === current) this.sendDiagnostics(queued);
				},
			);
			return true;
		} catch {
			current.diagnosticsSending = false;
			current.diagnosticsQueued = null;
			return false;
		}
	}

	async control(
		method: DesktopControlMessage["method"],
		deadlineMs = 5000,
	): Promise<DesktopControlResultMessage["result"] | null> {
		const current = this.active;
		if (!current || current.exited || current.shutdown || !current.ready) return null;
		const requestId = randomUUID();
		return await new Promise((resolve) => {
			let finished = false;
			const finish = (result: DesktopControlResultMessage["result"] | null): void => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				current.child.off("message", onMessage);
				resolve(result);
			};
			const onMessage = (message: unknown): void => {
				const parsed = desktopChildMessageSchema.safeParse(message);
				if (
					!parsed.success ||
					parsed.data.type !== "quarterdeck:desktop-control-result" ||
					parsed.data.startupId !== current.startupId ||
					parsed.data.requestId !== requestId
				)
					return;
				if (parsed.data.result.method === method || parsed.data.result.method === "failed")
					finish(parsed.data.result);
			};
			const timer = setTimeout(() => finish(null), deadlineMs);
			current.child.on("message", onMessage);
			void current.exit.then(() => finish(null));
			current.child.send(
				{
					type: "quarterdeck:desktop-control",
					protocolVersion: QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION,
					startupId: current.startupId,
					requestId,
					method,
				},
				(error) => {
					if (error) finish(null);
				},
			);
		});
	}

	private async requestShutdown(current: ChildGeneration): Promise<RuntimeShutdownOutcome> {
		const requestId = randomUUID();
		return await new Promise<RuntimeShutdownOutcome>((resolve) => {
			let result: RuntimeShutdownOutcome | null = null;
			let finished = false;
			const finish = (outcome: RuntimeShutdownOutcome): void => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				current.child.off("message", onMessage);
				resolve(outcome);
			};
			const onMessage = (message: unknown): void => {
				const parsed = desktopChildMessageSchema.safeParse(message);
				if (
					!parsed.success ||
					parsed.data.type !== "quarterdeck:desktop-shutdown-result" ||
					parsed.data.startupId !== current.startupId ||
					parsed.data.requestId !== requestId
				)
					return;
				result = parsed.data.outcome;
				if (result.status === "incomplete") finish(result);
			};
			const timer = setTimeout(() => finish(DEADLINE), this.options.shutdownDeadlineMs ?? 15_000);
			current.child.on("message", onMessage);
			void current.exit.then((code) => finish(result?.status === "clean" && code === 0 ? result : UNCONFIRMED));
			current.child.send(
				{
					type: "quarterdeck:desktop-shutdown",
					protocolVersion: QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION,
					startupId: current.startupId,
					requestId,
				},
				(error) => {
					if (error) finish(UNCONFIRMED);
				},
			);
		});
	}

	private evidence(current: ChildGeneration, phase: RuntimeSupervisorEvidence["phase"]): void {
		try {
			this.options.onEvidence({
				helperPid: current.child.pid ?? null,
				phase,
				generation: current.ready?.runtimeGeneration ?? null,
				runtimeOrigin: current.ready?.runtimeOrigin ?? null,
			});
		} catch {
			/* Observers cannot interrupt owned-child lifecycle handling. */
		}
	}
}
