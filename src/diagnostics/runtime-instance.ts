import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	normalizeDiagnosticErrorClass,
	type PublicRuntimeDiagnosticDescriptor,
	publicRuntimeDiagnosticDescriptorSchema,
	type RuntimeDiagnosticDescriptor,
	type RuntimeDiagnosticDescriptorStatus,
	runtimeDiagnosticDescriptorSchema,
} from "../core";
import { removeDirectoryWithRetries } from "../fs/remove-path.js";
import { getRuntimeHomePath } from "../state";
import { getDiagnosticErrorClass } from "./bounded-value";
import { ensurePrivateDiagnosticDirectories } from "./private-path";

const COMPLETED_INSTANCE_RETENTION = 3;

function platformFamily(): RuntimeDiagnosticDescriptor["platform"] {
	if (process.platform === "darwin") return "mac";
	if (process.platform === "linux") return "linux";
	if (process.platform === "win32") return "windows";
	return "other";
}

function nodeMajorVersion(): number {
	const parsed = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(tempPath, path);
}

export function getDiagnosticsRootPath(stateHome = getRuntimeHomePath()): string {
	return join(stateHome, "diagnostics");
}

export function getDiagnosticInstancesRootPath(stateHome = getRuntimeHomePath()): string {
	return join(getDiagnosticsRootPath(stateHome), "instances");
}

export function getDiagnosticBundlesRootPath(stateHome = getRuntimeHomePath()): string {
	return join(getDiagnosticsRootPath(stateHome), "bundles");
}

export interface CreateRuntimeDiagnosticInstanceOptions {
	stateHome?: string;
	host: string;
	port: number;
	quarterdeckVersion: string;
	onPersistenceFailure?: (error: Error) => void;
}

export class RuntimeDiagnosticInstance {
	readonly directory: string;
	readonly journalDirectory: string;
	readonly descriptorPath: string;
	private descriptor: RuntimeDiagnosticDescriptor;
	private persistent = true;
	private persistenceFailureClass: string | null = null;
	private didReportPersistenceFailure = false;
	private directoryPrepared = false;

	private constructor(
		directory: string,
		private readonly diagnosticsRoot: string,
		descriptor: RuntimeDiagnosticDescriptor,
		private readonly onPersistenceFailure: (error: Error) => void,
	) {
		this.directory = directory;
		this.journalDirectory = descriptor.journalDirectory;
		this.descriptorPath = join(directory, "runtime.json");
		this.descriptor = descriptor;
	}

	static async create(options: CreateRuntimeDiagnosticInstanceOptions): Promise<RuntimeDiagnosticInstance> {
		const runtimeInstanceId = randomUUID();
		const diagnosticsRoot = getDiagnosticsRootPath(options.stateHome);
		const instancesRoot = getDiagnosticInstancesRootPath(options.stateHome);
		const directory = join(instancesRoot, runtimeInstanceId);
		const journalDirectory = join(directory, "journal");
		const descriptor = runtimeDiagnosticDescriptorSchema.parse({
			version: 1,
			runtimeInstanceId,
			status: "starting",
			pid: process.pid,
			host: options.host,
			port: options.port,
			quarterdeckVersion: options.quarterdeckVersion,
			nodeMajorVersion: nodeMajorVersion(),
			platform: platformFamily(),
			startedAt: new Date().toISOString(),
			readyAt: null,
			stoppedAt: null,
			diagnosticToken: randomBytes(32).toString("base64url"),
			journalDirectory,
			failure: null,
		});
		const instance = new RuntimeDiagnosticInstance(
			directory,
			diagnosticsRoot,
			descriptor,
			options.onPersistenceFailure ?? (() => undefined),
		);
		try {
			await instance.prepareDirectory();
			await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
		} catch (error) {
			instance.notePersistenceFailure(error);
		}
		await instance.persist();
		if (instance.persistent) {
			await pruneFinalizedDiagnosticInstances(instancesRoot, runtimeInstanceId).catch(() => undefined);
		}
		return instance;
	}

	getDescriptor(): RuntimeDiagnosticDescriptor {
		return structuredClone(this.descriptor);
	}

	getPublicDescriptor(): PublicRuntimeDiagnosticDescriptor {
		return publicRuntimeDiagnosticDescriptorSchema.parse(this.descriptor);
	}

	getPersistenceHealth(): { persistent: boolean; failureClass: string | null } {
		return { persistent: this.persistent, failureClass: this.persistenceFailureClass };
	}

	verifyToken(candidate: string | undefined): boolean {
		if (!candidate) return false;
		const expected = Buffer.from(this.descriptor.diagnosticToken);
		const received = Buffer.from(candidate);
		return expected.length === received.length && timingSafeEqual(expected, received);
	}

	async markReady(host: string, port: number): Promise<void> {
		this.descriptor = {
			...this.descriptor,
			status: "ready",
			host,
			port,
			readyAt: new Date().toISOString(),
			failure: null,
		};
		await this.persist();
	}

	async markStopping(): Promise<void> {
		await this.updateStatus("stopping");
	}

	async markStopped(): Promise<void> {
		this.descriptor = {
			...this.descriptor,
			status: "stopped",
			stoppedAt: new Date().toISOString(),
		};
		await this.persist();
	}

	async markFailed(failureClass: string): Promise<void> {
		this.descriptor = {
			...this.descriptor,
			status: "failed",
			stoppedAt: new Date().toISOString(),
			failure: normalizeDiagnosticErrorClass(failureClass),
		};
		await this.persist();
	}

	private async updateStatus(status: RuntimeDiagnosticDescriptorStatus): Promise<void> {
		this.descriptor = { ...this.descriptor, status };
		await this.persist();
	}

	private async persist(): Promise<void> {
		try {
			await this.prepareDirectory();
			await writeJsonAtomic(this.descriptorPath, this.descriptor);
			this.notePersistenceSuccess();
		} catch (error) {
			this.notePersistenceFailure(error);
		}
	}

	private async prepareDirectory(): Promise<void> {
		if (this.directoryPrepared) return;
		await ensurePrivateDiagnosticDirectories([this.diagnosticsRoot, this.directory]);
		this.directoryPrepared = true;
	}

	private notePersistenceSuccess(): void {
		this.persistent = true;
		this.persistenceFailureClass = null;
		this.didReportPersistenceFailure = false;
	}

	private notePersistenceFailure(error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		this.persistent = false;
		this.persistenceFailureClass = getDiagnosticErrorClass(error);
		if (this.didReportPersistenceFailure) return;
		this.didReportPersistenceFailure = true;
		this.onPersistenceFailure(normalized);
	}
}

export async function readRuntimeDiagnosticDescriptor(path: string): Promise<RuntimeDiagnosticDescriptor> {
	const contents = await readFile(path, "utf8");
	return runtimeDiagnosticDescriptorSchema.parse(JSON.parse(contents) as unknown);
}

export interface DiscoveredRuntimeDiagnosticInstance {
	descriptor: RuntimeDiagnosticDescriptor;
	descriptorPath: string;
	pidAlive: boolean;
}

export function isDiagnosticProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

export async function discoverRuntimeDiagnosticInstances(
	stateHome = getRuntimeHomePath(),
): Promise<DiscoveredRuntimeDiagnosticInstance[]> {
	const instancesRoot = getDiagnosticInstancesRootPath(stateHome);
	let entries: Dirent[];
	try {
		entries = await readdir(instancesRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const discovered = (
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map(async (entry): Promise<DiscoveredRuntimeDiagnosticInstance | null> => {
					const descriptorPath = join(instancesRoot, entry.name, "runtime.json");
					try {
						const descriptor = await readRuntimeDiagnosticDescriptor(descriptorPath);
						if (descriptor.runtimeInstanceId !== entry.name) return null;
						return { descriptor, descriptorPath, pidAlive: isDiagnosticProcessAlive(descriptor.pid) };
					} catch {
						return null;
					}
				}),
		)
	).filter((entry): entry is DiscoveredRuntimeDiagnosticInstance => entry !== null);
	return discovered.sort((left, right) => right.descriptor.startedAt.localeCompare(left.descriptor.startedAt));
}

async function pruneFinalizedDiagnosticInstances(
	instancesRoot: string,
	activeRuntimeInstanceId: string,
): Promise<void> {
	const instances = await discoverRuntimeDiagnosticInstances(join(instancesRoot, "..", ".."));
	const finalized = instances.filter(
		(instance) => instance.descriptor.runtimeInstanceId !== activeRuntimeInstanceId && !instance.pidAlive,
	);
	for (const instance of finalized.slice(COMPLETED_INSTANCE_RETENTION)) {
		const directory = join(instancesRoot, instance.descriptor.runtimeInstanceId);
		await removeDirectoryWithRetries(directory);
	}
}
