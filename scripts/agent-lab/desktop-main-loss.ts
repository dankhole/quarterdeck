import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { readLabLaunchConfig } from "../../desktop/src/lab-launch-config.js";
import type { RuntimeTaskSessionSummary } from "../../src/core/api/task-session";
import { discoverRuntimeOwner } from "../../src/server/runtime-ownership.js";
import type { RuntimeProcessLiveness } from "../../src/server/runtime-process-identity.js";
import { readDesktopFakeHistory } from "./desktop-fake-history";
import { projectDesktopFakeReadiness } from "./desktop-fake-readiness";
import { assertDesktopFakeExactRecovery, assertDesktopFakeInvocationOwnership } from "./desktop-fake-recovery";
import type { DesktopLabFixture } from "./desktop-fixture";
import { collectOwnedDesktopProcesses, listDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import { type DesktopLabProcess, type DesktopProcessEvidence, DesktopProcessEvidenceSchema } from "./desktop-types";
import {
	type FakeInvocationReceipt,
	FakeInvocationReceiptSchema,
	readFakeInvocationReceipt,
} from "./fake-invocation-receipt";

const OBSERVATION_TIMEOUT_MS = 30_000;

/** Deliberately excludes the authenticated runtime descriptor. */
export interface DesktopMainLossOwner {
	generation: string;
	canonicalStateHome: string;
	pid: number;
	creationIdentity: string;
	processState: RuntimeProcessLiveness;
	released: boolean;
}

export interface DesktopMainLossHistory {
	sha256: string;
	bytes: number;
}

/** Captured primitives cannot follow later mutations of the retired driver's manifest. */
export interface DesktopMainLossFixtureIdentity {
	readonly runId: string;
	readonly appPath: string;
	readonly executablePath: string;
	readonly configPath: string;
	readonly tempRoot: string;
	readonly stateHome: string;
	readonly userDataPath: string;
	readonly projectPath: string;
	readonly hostSimulationConfigPath: string;
	readonly processEvidencePath: string;
	readonly home: string | null;
	readonly codexHome: string | null;
	readonly fakeAgentScript: string | null;
}

export interface DesktopMainLossOptions {
	taskId: string;
	session: RuntimeTaskSessionSummary;
	listProcesses?: () => Promise<DesktopLabProcess[]>;
	readEvidence?: () => Promise<DesktopProcessEvidence>;
	readOwner?: () => Promise<DesktopMainLossOwner | null>;
	readInvocation?: (sessionInstanceId: string) => Promise<FakeInvocationReceipt | null>;
	signalMain?: (pid: number, signal: "SIGKILL") => void;
	wait?: (milliseconds: number) => Promise<void>;
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export interface DesktopMainLossProof {
	signal: "SIGKILL";
	fixtureIdentity: DesktopMainLossFixtureIdentity;
	main: DesktopLabProcess;
	helper: DesktopLabProcess;
	provider: DesktopLabProcess;
	providerWorker: DesktopLabProcess;
	invocation: FakeInvocationReceipt;
	session: NonNullable<ReturnType<typeof projectDesktopFakeReadiness>>;
	history: DesktopMainLossHistory;
	ownershipBefore: DesktopMainLossOwner;
	ownershipAfter: DesktopMainLossOwner;
	/** Exact identities retained through reparenting, including children observed while draining. */
	ownedProcesses: DesktopLabProcess[];
	remainingProcesses: [];
	fallbackUsed: false;
}

export interface DesktopMainLossRecovery {
	fixture: DesktopLabFixture;
	evidence: DesktopProcessEvidence;
	session: RuntimeTaskSessionSummary;
	invocation: FakeInvocationReceipt | null;
	history: DesktopMainLossHistory;
	processes: DesktopLabProcess[];
	owner: DesktopMainLossOwner | null;
}

export class DesktopMainLossError extends Error {
	constructor(
		message: string,
		readonly mainSignalled: boolean,
		readonly ownedProcesses: readonly DesktopLabProcess[],
	) {
		super(message);
		this.name = "DesktopMainLossError";
	}
}

export async function readDesktopMainLossOwner(stateHome: string): Promise<DesktopMainLossOwner | null> {
	const owner = await discoverRuntimeOwner(stateHome);
	return owner
		? {
				generation: owner.claim.generation,
				canonicalStateHome: owner.claim.canonicalStateHome,
				pid: owner.claim.process.pid,
				creationIdentity: owner.claim.process.creationIdentity,
				processState: owner.processState,
				released: owner.released,
			}
		: null;
}

function validateFixture(fixture: DesktopLabFixture): void {
	const config = readLabLaunchConfig(fixture.configPath);
	if (
		fixture.manifest.agent.mode !== "fake" ||
		config.showWindow ||
		fixture.manifest.showWindow ||
		fixture.environment.QUARTERDECK_AGENT_LAB !== "1" ||
		fixture.environment.QUARTERDECK_DESKTOP_LAB_CONFIG !== fixture.configPath ||
		fixture.environment.QUARTERDECK_STATE_HOME !== config.stateHome ||
		fixture.manifest.tempRoot !== config.tempRoot ||
		fixture.manifest.stateHome !== config.stateHome ||
		fixture.manifest.userDataPath !== config.userDataPath ||
		Object.entries(config).some(
			([key, value]) =>
				value !== fixture.config[key as keyof typeof config] &&
				!(key === "showWindow" && value === false && fixture.config.showWindow === undefined),
		) ||
		!fixture.manifest.executablePath.startsWith(`${fixture.manifest.appPath}/Contents/MacOS/`)
	)
		throw new Error("Main-loss proof requires the validated hidden fake-provider fixture.");
}

function captureFixtureIdentity(fixture: DesktopLabFixture): DesktopMainLossFixtureIdentity {
	return Object.freeze({
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
	});
}

export function desktopMainLossHistoryMarker(fixture: DesktopLabFixture, taskId: string): string {
	if (!/^[a-zA-Z0-9-]{1,128}$/u.test(taskId)) throw new Error("Invalid synthetic main-loss task identity.");
	return `desktop-main-loss-${fixture.manifest.runId}-${taskId}`;
}

/** Read only the synthetic history seeded with /progress; return no transcript content. */
export async function readDesktopMainLossHistory(
	fixture: DesktopLabFixture,
	taskId: string,
): Promise<DesktopMainLossHistory> {
	validateFixture(fixture);
	return readDesktopFakeHistory({
		environment: fixture.environment,
		taskId,
		marker: desktopMainLossHistoryMarker(fixture, taskId),
	});
}

async function bounded<T>(operation: Promise<T>, remainingMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Main-loss observation deadline expired.")),
					Math.max(1, remainingMs),
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function sameOwner(left: DesktopMainLossOwner, right: DesktopMainLossOwner | null): right is DesktopMainLossOwner {
	return (
		right !== null &&
		left.generation === right.generation &&
		left.canonicalStateHome === right.canonicalStateHome &&
		left.pid === right.pid &&
		left.creationIdentity === right.creationIdentity
	);
}

function isFixtureMain(fixture: DesktopLabFixture, candidate: DesktopLabProcess): boolean {
	const marker = `--user-data-dir=${fixture.config.userDataPath}`;
	return (
		candidate.command.startsWith(`${fixture.manifest.executablePath} `) &&
		(candidate.command.endsWith(marker) || candidate.command.includes(`${marker} `))
	);
}

/**
 * Kill only the captured synthetic main, then observe the product's own parent-loss cleanup.
 * This function never cleans, deletes, retires a driver, acquires ownership, or launches a replacement.
 */
export async function proveDesktopMainProcessLoss(
	fixture: DesktopLabFixture,
	options: DesktopMainLossOptions,
): Promise<DesktopMainLossProof> {
	validateFixture(fixture);
	const fixtureIdentity = captureFixtureIdentity(fixture);
	const deadline = Date.now() + (options.timeoutMs ?? OBSERVATION_TIMEOUT_MS);
	const read = <T>(operation: Promise<T>): Promise<T> => bounded(operation, deadline - Date.now());
	const list = options.listProcesses ?? listDesktopProcesses;
	const readOwner = options.readOwner ?? (() => readDesktopMainLossOwner(fixture.config.stateHome));
	const readInvocation =
		options.readInvocation ??
		((sessionInstanceId) => readFakeInvocationReceipt({ stateHome: fixture.config.stateHome, sessionInstanceId }));
	const readEvidence =
		options.readEvidence ??
		(async () =>
			DesktopProcessEvidenceSchema.parse(
				JSON.parse(await readFile(fixture.config.processEvidencePath, "utf8")) as unknown,
			));
	let signalled = false;
	let owned = [...fixture.manifest.processes];
	try {
		const evidence = await read(readEvidence());
		const processes = await read(list());
		const main = owned.find((item) => item.pid === fixture.manifest.mainPid);
		const currentMain = processes.find((item) => item.pid === fixture.manifest.mainPid);
		const helper = processes.find((item) => item.pid === evidence.helperPid);
		const session = projectDesktopFakeReadiness(options.session, options.taskId);
		if (
			evidence.phase !== "ready" ||
			!evidence.generation ||
			evidence.appPid !== fixture.manifest.mainPid ||
			!main?.startedAt ||
			!currentMain ||
			!sameDesktopProcess(main, currentMain) ||
			currentMain.parentPid !== process.pid ||
			!isFixtureMain(fixture, currentMain) ||
			!helper?.startedAt ||
			!helper.command.includes(`${fixture.manifest.appPath}/Contents/Resources/runtime/`) ||
			!collectOwnedDesktopProcesses(processes, [], [main]).some((item) => sameDesktopProcess(item, helper)) ||
			!session
		)
			throw new Error("Main-loss proof could not confirm its exact main, helper, and fake launch identities.");
		const invocation = FakeInvocationReceiptSchema.safeParse(await read(readInvocation(session.sessionInstanceId)));
		if (!invocation.success || invocation.data.resumeKind !== "fresh" || invocation.data.requestedSessionId !== null)
			throw new Error("Main-loss proof lacks its initial fresh fake-provider invocation receipt.");
		const { pty: provider, worker: providerWorker } = assertDesktopFakeInvocationOwnership({
			launch: session,
			receipt: invocation.data,
			helper,
			processes,
		});
		assertSingleFakeTaskTree(fixture, helper, provider, providerWorker, processes);
		const history = await read(readDesktopMainLossHistory(fixture, options.taskId));
		const owner = await read(readOwner());
		if (
			!owner ||
			owner.generation !== evidence.generation ||
			owner.canonicalStateHome !== fixture.config.stateHome ||
			owner.pid !== helper.pid ||
			!owner.creationIdentity ||
			owner.released ||
			owner.processState !== "live"
		)
			throw new Error("Main-loss proof lacks the live helper's exact ownership claim.");
		const fresh = await read(list());
		const signalTarget = fresh.find((item) => item.pid === main.pid);
		const freshHelper = fresh.find((item) => item.pid === helper.pid);
		if (
			Date.now() >= deadline ||
			!signalTarget ||
			!sameDesktopProcess(main, signalTarget) ||
			signalTarget.parentPid !== process.pid ||
			!freshHelper ||
			!sameDesktopProcess(helper, freshHelper) ||
			!collectOwnedDesktopProcesses(fresh, [], [main]).some((item) => sameDesktopProcess(helper, item))
		)
			throw new Error("Main-loss proof refused a changed main identity before signalling.");
		const freshProvider = assertDesktopFakeInvocationOwnership({
			launch: session,
			receipt: invocation.data,
			helper,
			processes: fresh,
		});
		if (!sameDesktopProcess(provider, freshProvider.pty) || !sameDesktopProcess(providerWorker, freshProvider.worker))
			throw new Error("Main-loss proof lost the provider identity before signalling.");
		assertSingleFakeTaskTree(fixture, helper, freshProvider.pty, freshProvider.worker, fresh);
		owned = collectOwnedDesktopProcesses(fresh, [], [...owned, main, helper, provider, providerWorker]);
		(options.signalMain ?? ((pid) => process.kill(pid, "SIGKILL")))(signalTarget.pid, "SIGKILL");
		signalled = true;
		while (Date.now() < deadline) {
			const remaining = collectOwnedDesktopProcesses(await read(list()), [], owned);
			owned = [...new Map([...owned, ...remaining].map((item) => [item.pid, item])).values()];
			const after = await read(readOwner());
			if (!sameOwner(owner, after)) throw new Error("Main-loss ownership evidence changed or disappeared.");
			if (remaining.length === 0 && after.released && after.processState === "dead")
				return {
					signal: "SIGKILL",
					fixtureIdentity,
					main,
					helper,
					provider,
					providerWorker,
					invocation: invocation.data,
					session,
					history,
					ownershipBefore: owner,
					ownershipAfter: after,
					ownedProcesses: owned,
					remainingProcesses: [],
					fallbackUsed: false,
				};
			await read(
				(options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
					options.pollIntervalMs ?? 100,
				),
			);
		}
		throw new Error("Main-loss cleanup was not confirmed before its observation deadline.");
	} catch (error) {
		throw new DesktopMainLossError(
			error instanceof Error ? error.message : "Main-loss proof could not be confirmed.",
			signalled,
			owned,
		);
	}
}

/** The fake script's fixed app-server branch is metadata RPC, not a task-provider launch. */
function isFakeTaskProcess(candidate: DesktopLabProcess, script: string): boolean {
	const position = candidate.command.indexOf(script);
	if (position < 1 || candidate.command[position - 1] !== " ") return false;
	const suffix = candidate.command.slice(position + script.length);
	return (suffix === "" || suffix.startsWith(" ")) && suffix !== " app-server" && !suffix.startsWith(" app-server ");
}

function assertSingleFakeTaskTree(
	fixture: DesktopLabFixture,
	helper: DesktopLabProcess,
	provider: DesktopLabProcess,
	worker: DesktopLabProcess,
	processes: DesktopLabProcess[],
): void {
	const script = fixture.environment.QUARTERDECK_AGENT_LAB_FAKE_AGENT;
	if (!script || !isAbsolute(script)) throw new Error("Main-loss proof has no fixed synthetic provider script.");
	const helperTree = collectOwnedDesktopProcesses(processes, [], [helper]);
	const fakeProcesses = helperTree.filter((item) => isFakeTaskProcess(item, script));
	// A TSX wrapper and its worker form one provider tree; sibling roots are duplicates.
	const fakeRoots = fakeProcesses.filter(
		(candidate) =>
			!fakeProcesses.some(
				(parent) =>
					parent.pid !== candidate.pid &&
					collectOwnedDesktopProcesses(helperTree, [], [parent]).some((item) => item.pid === candidate.pid),
			),
	);
	const root = fakeRoots[0];
	if (
		fakeRoots.length !== 1 ||
		!root ||
		!isFakeTaskProcess(worker, script) ||
		!collectOwnedDesktopProcesses(helperTree, [], [provider]).some((item) => sameDesktopProcess(item, root)) ||
		!collectOwnedDesktopProcesses(helperTree, [], [root]).some((item) => sameDesktopProcess(item, worker))
	)
		throw new Error("Main-loss recovery did not retain exactly one owned fake-provider tree.");
}

/** Prove exact targeted recovery, rather than the fake's deterministic task-derived session name. */
export function assertDesktopMainLossRecovery(before: DesktopMainLossProof, after: DesktopMainLossRecovery) {
	const { fixture, evidence, processes } = after;
	validateFixture(fixture);
	const identity = captureFixtureIdentity(fixture);
	if (Object.entries(before.fixtureIdentity).some(([key, value]) => identity[key as keyof typeof identity] !== value))
		throw new Error("Main-loss recovery did not relaunch the exact retained fixture.");
	const main = processes.find((item) => item.pid === fixture.manifest.mainPid);
	const helper = processes.find((item) => item.pid === evidence.helperPid);
	const session = projectDesktopFakeReadiness(after.session, before.session.taskId);
	const owner = after.owner;
	if (
		evidence.phase !== "ready" ||
		!evidence.generation ||
		evidence.generation === before.ownershipBefore.generation ||
		evidence.appPid !== fixture.manifest.mainPid ||
		!main?.startedAt ||
		main.parentPid !== process.pid ||
		!isFixtureMain(fixture, main) ||
		sameDesktopProcess(before.main, main) ||
		!helper?.startedAt ||
		sameDesktopProcess(before.helper, helper) ||
		!helper.command.includes(`${fixture.manifest.appPath}/Contents/Resources/runtime/`) ||
		!collectOwnedDesktopProcesses(processes, [], [main]).some((item) => sameDesktopProcess(item, helper)) ||
		!owner ||
		owner.generation !== evidence.generation ||
		owner.canonicalStateHome !== before.ownershipBefore.canonicalStateHome ||
		owner.canonicalStateHome !== fixture.config.stateHome ||
		owner.pid !== helper.pid ||
		!owner.creationIdentity ||
		owner.creationIdentity === before.ownershipBefore.creationIdentity ||
		owner.released ||
		owner.processState !== "live" ||
		!session ||
		session.providerSessionId !== before.session.providerSessionId ||
		session.sessionInstanceId === before.session.sessionInstanceId ||
		session.hook.deliveryId === before.session.hook.deliveryId
	)
		throw new Error("Main-loss recovery lacks fresh main, helper, ownership, and native launch evidence.");
	if (collectOwnedDesktopProcesses(processes, [], before.ownedProcesses).length > 0)
		throw new Error("Main-loss recovery still has a previous generation's owned process.");
	if (after.history.sha256 !== before.history.sha256 || after.history.bytes !== before.history.bytes)
		throw new Error("Main-loss recovery did not preserve the exact seeded synthetic history.");
	const invocation = FakeInvocationReceiptSchema.safeParse(after.invocation);
	if (
		!invocation.success ||
		invocation.data.taskId !== session.taskId ||
		invocation.data.sessionInstanceId !== session.sessionInstanceId ||
		invocation.data.providerSessionId !== before.session.providerSessionId ||
		invocation.data.resumeKind !== "targeted" ||
		invocation.data.requestedSessionId !== before.session.providerSessionId ||
		!invocation.data.historyPresent
	)
		throw new Error("Main-loss recovery lacks an exact targeted fake-provider resume receipt.");
	assertDesktopFakeExactRecovery({
		before: before.session,
		after: session,
		beforeReceipt: before.invocation,
		afterReceipt: invocation.data,
	});
	const { pty: provider, worker: providerWorker } = assertDesktopFakeInvocationOwnership({
		launch: session,
		receipt: invocation.data,
		helper,
		processes,
	});
	assertSingleFakeTaskTree(fixture, helper, provider, providerWorker, processes);
	return {
		main,
		helper,
		provider,
		providerWorker,
		session,
		invocation: invocation.data,
		history: after.history,
		generation: evidence.generation,
	};
}
