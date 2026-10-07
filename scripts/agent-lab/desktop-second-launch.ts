import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readLabLaunchConfig } from "../../desktop/src/lab-launch-config.js";
import { isFileSystemPathWithin } from "../../src/core/path-comparison.js";
import {
	DESKTOP_LAUNCH_ARGUMENT,
	type DesktopLaunchRequest,
	desktopLaunchRequestSchema,
	serializeDesktopLaunchRequest,
} from "../../src/shared/desktop-launch-contract.js";
import type { DesktopLabFixture } from "./desktop-fixture";
import {
	collectOwnedDesktopProcesses,
	findMarkedDesktopProcesses,
	listDesktopProcesses,
	sameDesktopProcess,
} from "./desktop-processes";
import { type DesktopLabProcess, type DesktopProcessEvidence, DesktopProcessEvidenceSchema } from "./desktop-types";

export interface DesktopSecondLaunchOptions {
	/** The driver installs a lab-only observer on the existing app before calling this proof. */
	readSecondInstanceCount: () => Promise<number>;
	launchRequest?: DesktopLaunchRequest;
	selectedApplication?: { appPath: string; executablePath: string };
	/** Driver admission is checked synchronously after all reads, immediately before spawning. */
	assertLaunchAllowed?: () => void;
	spawnProcess?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
	listProcesses?: () => Promise<DesktopLabProcess[]>;
	readEvidence?: () => Promise<DesktopProcessEvidence>;
	timeoutMs?: number;
	cleanupTimeoutMs?: number;
	pollIntervalMs?: number;
}

export interface DesktopSecondLaunchProof {
	secondPid: number;
	exitCode: 0;
	original: { appPid: number; appBirth: string; helperPid: number; helperBirth: string; generation: string };
	notificationCountBefore: number;
	notificationCountAfter: number;
}

export class DesktopSecondLaunchError extends Error {
	readonly code = "DesktopSecondLaunchFailed";
	constructor(
		message: string,
		readonly secondPid: number | null,
		readonly secondProcesses: readonly DesktopLabProcess[],
		readonly cleanupConfirmed: boolean,
	) {
		super(message);
		this.name = "DesktopSecondLaunchError";
	}
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Second-launch proof timed out.")), Math.max(1, timeoutMs));
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function hasExecutable(process: DesktopLabProcess, executable: string): boolean {
	return process.command === executable || process.command.startsWith(`${executable} `);
}

function validateFixture(fixture: DesktopLabFixture): void {
	const config = readLabLaunchConfig(fixture.configPath);
	if (
		config.showWindow ||
		fixture.config.showWindow ||
		fixture.manifest.showWindow ||
		fixture.environment.QUARTERDECK_DESKTOP_LAB_CONFIG !== fixture.configPath ||
		fixture.environment.QUARTERDECK_STATE_HOME !== config.stateHome ||
		fixture.manifest.tempRoot !== config.tempRoot ||
		fixture.manifest.stateHome !== config.stateHome ||
		fixture.manifest.userDataPath !== config.userDataPath ||
		fixture.manifest.projectPath !== config.projectPath ||
		Object.entries(config).some(
			([key, value]) =>
				value !== fixture.config[key as keyof typeof config] &&
				!(key === "showWindow" && value === false && fixture.config.showWindow === undefined),
		)
	)
		throw new Error("Second launch requires the existing validated hidden lab fixture.");
	if (!fixture.manifest.executablePath.startsWith(`${fixture.manifest.appPath}/Contents/MacOS/`))
		throw new Error("Second launch must reuse the packaged lab executable.");
}

/** Reuse the first instance's fixture. This function never stops or deletes its app, helper, or state. */
export async function proveDesktopSecondLaunch(
	fixture: DesktopLabFixture,
	options: DesktopSecondLaunchOptions,
): Promise<DesktopSecondLaunchProof> {
	validateFixture(fixture);
	const selected = options.selectedApplication ?? fixture.manifest;
	if (
		options.selectedApplication &&
		(!options.launchRequest ||
			!isFileSystemPathWithin(fixture.config.tempRoot, selected.appPath) ||
			!selected.executablePath.startsWith(`${selected.appPath}/Contents/MacOS/`))
	)
		throw new Error("Alternate second launch must remain in the isolated fixture.");
	if (options.launchRequest) {
		const request = desktopLaunchRequestSchema.parse(options.launchRequest);
		if (
			request.appPath !== selected.appPath ||
			request.stateHome !== fixture.config.stateHome ||
			(request.projectPath !== undefined && !isFileSystemPathWithin(fixture.config.tempRoot, request.projectPath))
		)
			throw new Error("Second launch request escaped the isolated fixture.");
	}
	const timeout = options.timeoutMs ?? 10_000;
	const deadline = Date.now() + timeout;
	const list = options.listProcesses ?? listDesktopProcesses;
	const readEvidence =
		options.readEvidence ??
		(async () =>
			DesktopProcessEvidenceSchema.parse(
				JSON.parse(await readFile(fixture.config.processEvidencePath, "utf8")) as unknown,
			));
	const read = <T>(operation: Promise<T>): Promise<T> => bounded(operation, deadline - Date.now());
	const before = await read(readEvidence());
	if (
		before.phase !== "ready" ||
		!before.appPid ||
		!before.helperPid ||
		!before.generation ||
		fixture.manifest.mainPid !== before.appPid
	)
		throw new Error("The original desktop runtime must be ready before its second launch.");
	const beforeProcesses = await read(list());
	const app = beforeProcesses.find((item) => item.pid === before.appPid);
	const helper = beforeProcesses.find((item) => item.pid === before.helperPid);
	if (
		!app?.startedAt ||
		!helper?.startedAt ||
		!hasExecutable(app, fixture.manifest.executablePath) ||
		!helper.command.includes(`${fixture.manifest.appPath}/Contents/Resources/runtime/`) ||
		!collectOwnedDesktopProcesses(beforeProcesses, [app.pid]).some((item) => sameDesktopProcess(item, helper))
	)
		throw new Error("Original desktop process identities could not be confirmed.");
	const countBefore = await read(options.readSecondInstanceCount());
	if (!Number.isSafeInteger(countBefore) || countBefore < 0)
		throw new Error("Invalid single-instance notification evidence.");
	let child: ChildProcess | null = null;
	let exited = false;
	let exitCode: number | null = null;
	let childError = false;
	let secondProcesses: DesktopLabProcess[] = [];
	let failure = "Second-launch proof failed.";
	const onExit = (code: number | null): void => {
		exited = true;
		exitCode = code;
	};
	const onError = (): void => {
		childError = true;
	};
	const observe = (processes: DesktopLabProcess[]): void => {
		if (!child?.pid || child.pid === app.pid || child.pid === helper.pid) return;
		const candidate = processes.find((item) => item.pid === child?.pid);
		const retained = secondProcesses.find((item) => item.pid === child?.pid);
		if (
			!retained &&
			candidate?.startedAt &&
			candidate?.parentPid === process.pid &&
			hasExecutable(candidate, selected.executablePath)
		)
			secondProcesses.push(candidate);
		secondProcesses = [
			...new Map(
				[...secondProcesses, ...collectOwnedDesktopProcesses(processes, [], secondProcesses)].map((item) => [
					item.pid,
					item,
				]),
			).values(),
		];
	};
	try {
		options.assertLaunchAllowed?.();
		child = (options.spawnProcess ?? spawn)(
			selected.executablePath,
			[
				"--use-mock-keychain",
				`--user-data-dir=${fixture.config.userDataPath}`,
				...(options.launchRequest
					? [DESKTOP_LAUNCH_ARGUMENT, serializeDesktopLaunchRequest(options.launchRequest)]
					: []),
			],
			{
				cwd: fixture.config.projectPath,
				env: { ...fixture.environment },
				stdio: "ignore",
				shell: false,
				detached: false,
				windowsHide: true,
			},
		);
		child.on("exit", onExit);
		child.on("error", onError);
		if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode);
		if (!child.pid || child.pid === app.pid || child.pid === helper.pid)
			throw new Error("Second launch did not identify a separate owned child.");
		while (Date.now() < deadline) {
			const processes = await read(list());
			observe(processes);
			const evidence = await read(readEvidence());
			if (
				!processes.some((item) => sameDesktopProcess(item, app)) ||
				!processes.some((item) => sameDesktopProcess(item, helper)) ||
				evidence.phase !== "ready" ||
				evidence.appPid !== before.appPid ||
				evidence.helperPid !== before.helperPid ||
				evidence.generation !== before.generation ||
				evidence.runtimeOrigin !== before.runtimeOrigin
			)
				throw new Error("Second launch replaced or changed the original app or runtime.");
			const marked = [fixture.manifest.appPath, selected.appPath].flatMap((appPath) =>
				findMarkedDesktopProcesses(
					processes,
					appPath,
					fixture.config.userDataPath,
					fixture.config.hostSimulationConfigPath,
				),
			);
			if (
				processes.some(
					(item) =>
						item.pid !== helper.pid &&
						marked.includes(item.pid) &&
						[fixture.manifest.appPath, selected.appPath].some((appPath) =>
							item.command.includes(`${appPath}/Contents/Resources/runtime/`),
						),
				)
			)
				throw new Error("Second launch started a duplicate runtime helper.");
			if (childError || (exited && exitCode !== 0)) throw new Error("The second application did not exit cleanly.");
			const countAfter = await read(options.readSecondInstanceCount());
			if (!Number.isSafeInteger(countAfter) || countAfter < countBefore)
				throw new Error("Invalid single-instance notification evidence.");
			if (countAfter > countBefore + 1) throw new Error("Multiple second-instance launches overlapped this proof.");
			if (exited && countAfter > countBefore) {
				if (secondProcesses.some((known) => processes.some((current) => sameDesktopProcess(known, current))))
					throw new Error("Second launch left an owned process running.");
				return {
					secondPid: child.pid,
					exitCode: 0,
					original: {
						appPid: app.pid,
						appBirth: app.startedAt,
						helperPid: helper.pid,
						helperBirth: helper.startedAt,
						generation: before.generation,
					},
					notificationCountBefore: countBefore,
					notificationCountAfter: countAfter,
				};
			}
			await read(new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 50)));
		}
		throw new Error("Second launch did not confirm the single-instance path before its deadline.");
	} catch (error) {
		if (error instanceof Error) failure = error.message;
		const cleanupDeadline = Date.now() + (options.cleanupTimeoutMs ?? 2_000);
		let confirmed = child === null || (!child.pid && childError);
		try {
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				const processes = await bounded(list(), cleanupDeadline - Date.now());
				observe(processes);
				const ownedRoot = secondProcesses.find((item) => item.pid === child?.pid);
				const currentRoot = processes.find((item) => item.pid === child?.pid);
				if (!exited && ownedRoot && currentRoot && sameDesktopProcess(ownedRoot, currentRoot)) child?.kill(signal);
				while (Date.now() < cleanupDeadline) {
					const remaining = await bounded(list(), cleanupDeadline - Date.now());
					observe(remaining);
					if (
						exited &&
						!secondProcesses.some((known) => remaining.some((current) => sameDesktopProcess(known, current)))
					) {
						confirmed = true;
						break;
					}
					await bounded(
						new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 50)),
						cleanupDeadline - Date.now(),
					);
					if (signal === "SIGTERM") break;
				}
				if (confirmed) break;
			}
		} catch {
			confirmed = false;
		}
		throw new DesktopSecondLaunchError(failure, child?.pid ?? null, secondProcesses, confirmed);
	} finally {
		child?.off("exit", onExit);
		child?.off("error", onError);
	}
}
