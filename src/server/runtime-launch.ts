import type { DesktopReadyMessage, DesktopStartupMessage } from "../core/api/desktop-runtime-protocol.js";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../core/api/runtime-protocol.js";
import type { RuntimeShutdownOutcome } from "../core/api/runtime-shutdown.js";
import {
	createRuntimeCapabilities,
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimePort,
	type RuntimeCapabilities,
} from "../core/index.js";
import { installRuntimeProcessLaunchAdmission } from "../core/runtime-process-launch-admission.js";
import { getRuntimeHomePath, isUnderWorktreesHome } from "../state/project-state.js";
import { installRuntimeWriteAdmission, waitForRuntimeWriteQuiescence } from "../state/runtime-write-admission.js";
import { createDesktopRuntimeHostEffects, type DesktopHostEffectRequest } from "./desktop-runtime-host-effects.js";
import { type RuntimeHandle, startRuntime } from "./runtime-bootstrap.js";
import { RuntimeClientAccess } from "./runtime-client-access.js";
import {
	createOwnerBrowserBootstrap,
	enrollDesktopClient,
	openOwnerProject,
	revokeDesktopClient,
	verifyRuntimeOwner,
	waitForReadyRuntimeOwner,
} from "./runtime-owner-client.js";
import { acquireRuntimeOwnership } from "./runtime-ownership.js";
import { assertRuntimeRecoveryAdmission } from "./runtime-recovery-admission.js";
import { hasGitRepository } from "./runtime-startup-paths.js";

export interface RuntimeLaunchOptions {
	quarterdeckVersion: string;
	nativeUiAvailable: boolean;
	hostSimulationConfigPath: string | null;
	skipShutdownCleanup: boolean;
	desktopStartup: DesktopStartupMessage | null;
	desktopRequestHostEffect?: DesktopHostEffectRequest;
}

export interface AdmittedRuntimeLaunch {
	kind: "owned" | "attached";
	runtime: RuntimeHandle | null;
	url: string;
	capabilities: RuntimeCapabilities;
	ready: Omit<DesktopReadyMessage, "type" | "protocolVersion" | "startupId">;
	createBrowserUrl: () => Promise<string>;
	shutdown: (waitForCompletion?: boolean) => Promise<RuntimeShutdownOutcome>;
}

const CLEAN_SHUTDOWN: RuntimeShutdownOutcome = { status: "clean", safeToExit: true, safeToReleaseOwnership: true };

/** The only ordinary CLI/desktop launch path that can create a writable runtime. */
export async function startAdmittedRuntime(options: RuntimeLaunchOptions): Promise<AdmittedRuntimeLaunch> {
	let runtime: RuntimeHandle | null = null;
	let ownershipLost = false;
	let stopOnLoss: (() => Promise<RuntimeShutdownOutcome>) | null = null;
	const capabilities = createRuntimeCapabilities(
		options.hostSimulationConfigPath ? "simulated" : options.nativeUiAvailable ? "native" : "unavailable",
	);
	const admission = await acquireRuntimeOwnership({
		stateHome: getRuntimeHomePath(),
		quarterdeckVersion: options.quarterdeckVersion,
		capabilities: {
			transportVersion: 1,
			browserHttp: true,
			browserWebSocket: true,
			desktopProxy: true,
			desktopBridgeVersion: 1,
		},
		onOwnershipLost: () => {
			ownershipLost = true;
			void stopOnLoss?.().then(
				() => {
					process.exitCode = 1;
				},
				() => {
					process.exitCode = 1;
				},
			);
		},
	});
	if (admission.kind === "occupied") {
		process.env.QUARTERDECK_STATE_HOME = admission.owner.claim.canonicalStateHome;
		const descriptor = await waitForReadyRuntimeOwner(admission.owner);
		const origin = await verifyRuntimeOwner(descriptor, options.desktopStartup !== null);
		let path = "/";
		if (
			(!options.desktopStartup || options.hostSimulationConfigPath) &&
			!isUnderWorktreesHome(process.cwd()) &&
			(await hasGitRepository(process.cwd()))
		) {
			path = `/${encodeURIComponent(await openOwnerProject(descriptor, process.cwd()))}`;
		}
		if (options.desktopStartup) await enrollDesktopClient(descriptor, options.desktopStartup.clientToken);
		let detach: Promise<RuntimeShutdownOutcome> | null = null;
		return {
			kind: "attached",
			runtime: null,
			url: `${origin}${path}`,
			capabilities,
			ready: {
				runtimeOrigin: origin,
				runtimeGeneration: descriptor.generation,
				instanceId: descriptor.generation,
				diagnosticInstanceId: null,
				browserProtocolVersion: descriptor.runtimeProtocolVersion,
				packageVersion: descriptor.quarterdeckVersion,
				desktopBridgeVersion: 1,
				desktopTransportVersion: 1,
				ownership: "attached",
			},
			createBrowserUrl: () => createOwnerBrowserBootstrap(descriptor, path),
			shutdown: () => {
				detach ??= (async () => {
					if (options.desktopStartup) {
						// Detachment must not stop the independently owned runtime. A
						// failed revocation cannot keep an otherwise resource-free relay alive.
						await revokeDesktopClient(descriptor, options.desktopStartup.clientToken).catch(() => undefined);
					}
					return CLEAN_SHUTDOWN;
				})();
				return detach;
			},
		};
	}

	const { lease } = admission;
	let processLaunchesAllowed = true;
	let writesAllowed = true;
	process.env.QUARTERDECK_STATE_HOME = lease.canonicalStateHome;
	installRuntimeWriteAdmission({
		canonicalStateHome: lease.canonicalStateHome,
		isCurrent: () => writesAllowed && lease.isCurrent(),
	});
	installRuntimeProcessLaunchAdmission({
		beforeSpawn: () => {
			if (!processLaunchesAllowed) throw new Error("Runtime process launches have stopped.");
			lease.assertCurrent();
			lease.markProcessCustodyDirty();
		},
	});
	const access = new RuntimeClientAccess({ generation: lease.generation, management: lease });
	if (options.desktopStartup) access.registerDesktopClient(options.desktopStartup.clientToken);
	// On startup failure the process retains the claim until it exits. An error
	// is never evidence that partially constructed writers have quiesced.
	runtime = await startRuntime({
		quarterdeckVersion: options.quarterdeckVersion,
		capabilities,
		simulationConfigPath: options.hostSimulationConfigPath,
		clientAccess: access,
		listenPort: options.desktopStartup ? 0 : undefined,
		registerCwdProject: !options.desktopStartup || options.hostSimulationConfigPath !== null,
		hostIntegrationOverrides:
			options.desktopStartup && !options.hostSimulationConfigPath && options.desktopRequestHostEffect
				? createDesktopRuntimeHostEffects(options.desktopRequestHostEffect, lease.generation)
				: undefined,
		persistenceAllowed: () => lease.isCurrent(),
		beforeProcessSnapshot: () => {
			// Already admitted producers may need children while draining. Once
			// drained, no new child may escape the authoritative shutdown snapshot.
			processLaunchesAllowed = false;
		},
		beforeStartup: async () => lease.assertCurrent(),
		beforeRecovery: () =>
			assertRuntimeRecoveryAdmission({
				stateHome: lease.canonicalStateHome,
				currentGeneration: lease.generation,
				bootIdentity: lease.bootIdentity,
			}),
		onReady: async () => lease.markReady({ host: getQuarterdeckRuntimeHost(), port: getQuarterdeckRuntimePort() }),
	});
	const running = runtime;
	let shutdownPromise: ReturnType<RuntimeHandle["shutdown"]> | null = null;
	let finalOutcome: RuntimeShutdownOutcome | null = null;
	let releasePromise: Promise<void> | null = null;
	const finish = async (result: RuntimeShutdownOutcome): Promise<RuntimeShutdownOutcome> => {
		const outcome: RuntimeShutdownOutcome = ownershipLost
			? {
					status: "incomplete",
					safeToExit: false,
					safeToReleaseOwnership: false,
					reasons: ["ownership_lost"],
				}
			: result;
		if (outcome.safeToReleaseOwnership && !ownershipLost) {
			// Close admission before awaiting the counter: a zero count is not a
			// fence against a new writer entering on the following microtask.
			writesAllowed = false;
			await waitForRuntimeWriteQuiescence(lease.canonicalStateHome);
			releasePromise ??= lease.release();
			await releasePromise;
		}
		finalOutcome = outcome;
		return outcome;
	};
	const shutdown = async (waitForCompletion = false): Promise<RuntimeShutdownOutcome> => {
		if (finalOutcome) return finalOutcome;
		if (!shutdownPromise) {
			// Publish the shared promise before calling lease code: discovering a
			// lost lease may synchronously re-enter this path through its callback.
			shutdownPromise = Promise.resolve().then(async () => {
				access.clear();
				if (!ownershipLost) {
					try {
						await lease.markStopping();
					} catch {
						// Descriptor publication is observation, not cleanup authority.
						// I/O failure or lease loss must still drain the runtime.
						running.diagnostics.recordEvent(
							"runtime.ownership_stopping_publication_failed",
							{},
							{},
							{ level: "warn", essential: true },
						);
					}
				}
				const result = await running.shutdown({
					skipSessionCleanup: options.skipShutdownCleanup,
					persistenceAllowed: !ownershipLost,
				});
				void result.completion.then(finish).catch(() => undefined);
				return result;
			});
		}
		const result = await shutdownPromise;
		if (result.outcome.safeToExit) return await finish(result.outcome);
		return waitForCompletion ? await finish(await result.completion) : (finalOutcome ?? result.outcome);
	};
	stopOnLoss = () => shutdown(true);
	if (ownershipLost) {
		await shutdown(true);
		throw new Error("Runtime ownership was lost during startup.");
	}
	const url = new URL(running.url);
	return {
		kind: "owned",
		runtime: running,
		url: running.url,
		capabilities,
		ready: {
			runtimeOrigin: url.origin,
			runtimeGeneration: lease.generation,
			instanceId: lease.generation,
			diagnosticInstanceId: running.diagnostics.runtimeInstanceId,
			browserProtocolVersion: QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
			packageVersion: options.quarterdeckVersion,
			desktopBridgeVersion: 1,
			desktopTransportVersion: 1,
			ownership: "owned",
		},
		createBrowserUrl: async () => `${url.origin}${access.createBrowserBootstrap(url.pathname)}`,
		shutdown,
	};
}
