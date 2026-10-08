import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeOwnershipClaim } from "../core/api/runtime-management.js";
import {
	type ManagedProcessOwnershipRecord,
	readManagedProcessOwnershipEvidence,
} from "../terminal/managed-process-ownership.js";
import { type OwnedProcessSnapshot, queryOwnedProcessSnapshot } from "./owned-process-snapshot.js";

export interface PriorRuntimeProcessCustody {
	claim: RuntimeOwnershipClaim;
	released: boolean;
	custodyDirty: boolean | null;
}

export class RuntimeRecoveryAdmissionError extends Error {
	readonly code = "RuntimeRecoveryAdmissionDenied";
	constructor(
		readonly reason:
			| "live_prior_process"
			| "unverifiable_evidence"
			| "unconfirmed_prior_custody"
			| "boot_identity_unavailable",
		readonly pids: readonly number[] = [],
	) {
		super(
			reason === "live_prior_process"
				? `Quarterdeck cannot safely recover tasks while prior process evidence is still live (PIDs: ${pids.join(", ")}). Inspect these processes and stop the prior agents before reopening Quarterdeck. No processes were killed and saved sessions were retained.`
				: reason === "unconfirmed_prior_custody"
					? "Quarterdeck cannot prove that a prior agent's detached children have exited. Run quarterdeck recover to inspect the saved process evidence. After checking and stopping prior agents and background commands, run quarterdeck recover --confirm-stopped, then reopen Quarterdeck. Restarting the computer is also an option when boot identity is available. No processes were killed and saved sessions were retained."
					: reason === "boot_identity_unavailable"
						? "Quarterdeck could not verify the current boot identity. Recovery acknowledgement is unavailable until the system boot query succeeds. No processes were killed and saved sessions were retained."
						: "Quarterdeck could not verify prior process evidence. Inspect saved session/process evidence and retry after the system process query is available. No processes were killed and saved sessions were retained.",
		);
		this.name = "RuntimeRecoveryAdmissionError";
	}
}

export function bootIdentityKind(identity: string | null | undefined): string | null {
	if (!identity) return null;
	if (
		/^(linux|darwin|windows):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(identity) &&
		!identity.endsWith(":00000000-0000-0000-0000-000000000000")
	) {
		return identity.split(":")[0] ?? null;
	}
	return null;
}

export function differentBoot(prior: string | null | undefined, current: string | null): boolean {
	const kind = bootIdentityKind(prior);
	return kind !== null && kind === bootIdentityKind(current) && prior !== current;
}

/** History is validated by ownership admission and ordered from oldest to newest. */
export function assertPriorRuntimeProcessCustody(
	history: readonly PriorRuntimeProcessCustody[],
	currentBootIdentity: string | null,
	acknowledgedBoundary: string | null = null,
): void {
	const boundaryIndex = history.findIndex((owner) => owner.claim.generation === acknowledgedBoundary);
	for (let index = 0; index < history.length; index++) {
		const owner = history[index];
		if (index <= boundaryIndex) continue;
		if (owner?.claim.purpose !== "runtime" || owner.released) continue;
		if (owner.claim.custodyProtocolVersion === 1 && owner.custodyDirty === false) continue;
		if (differentBoot(owner.claim.bootIdentity, currentBootIdentity)) continue;
		// A later claim records an observation boundary for older unknown custody.
		// After reboot all processes predating that boundary must have exited.
		if (history.slice(index + 1).some((later) => differentBoot(later.claim.bootIdentity, currentBootIdentity)))
			continue;
		throw new RuntimeRecoveryAdmissionError("unconfirmed_prior_custody");
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unreadable process evidence.");
	return value as Record<string, unknown>;
}

async function readEvidence(path: string): Promise<Record<string, unknown> | null> {
	try {
		return record(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function collectPid(value: unknown, pids: Set<number>): void {
	if (value === null || value === undefined) return;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid saved PID.");
	pids.add(value);
}

function collectSessions(sessions: Record<string, unknown>, pids: Set<number>): void {
	for (const summary of Object.values(sessions)) collectPid(record(summary).pid, pids);
}

export interface SavedRuntimeProcessEvidence {
	pids: ReadonlySet<number>;
	sessionPids: ReadonlySet<number>;
	managed: readonly ManagedProcessOwnershipRecord[];
}

/** Reads saved evidence without replaying transactions, retiring records or sending signals. */
export async function readSavedRuntimeProcessEvidence(stateHome: string): Promise<SavedRuntimeProcessEvidence> {
	const pids = new Set<number>();
	const projectsRoot = join(stateHome, "projects");
	let entries: Dirent[];
	try {
		entries = await readdir(projectsRoot, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		entries = [];
	}
	if (entries.length > 10_000) throw new Error("Process evidence exceeds its bounded size.");
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const projectPath = join(projectsRoot, entry.name);
		const sessions = await readEvidence(join(projectPath, "sessions.json"));
		if (sessions) collectSessions(sessions, pids);
		const transaction = await readEvidence(join(projectPath, "state-transaction.json"));
		if (transaction) collectSessions(record(transaction.sessions), pids);
		const execution = await readEvidence(join(projectPath, "execution-ownership.json"));
		if (execution) {
			for (const owner of Object.values(record(execution.owners))) {
				const processIdentity = record(owner).ownerProcess;
				if (processIdentity !== null && processIdentity !== undefined) {
					collectPid(record(processIdentity).pid, pids);
				}
			}
		}
	}
	const sessionPids = new Set(pids);
	const managed = await readManagedProcessOwnershipEvidence(stateHome);
	for (const evidence of managed) pids.add(evidence.rootProcess.pid);
	return { pids, sessionPids, managed };
}

export interface SavedRuntimeProcessInspectionOptions {
	platform?: NodeJS.Platform;
	snapshot?: () => Promise<OwnedProcessSnapshot[]>;
}

/** PID-only observations may refuse recovery; they never authorize a signal. */
export async function assertSavedRuntimeProcessesAbsent(
	evidence: SavedRuntimeProcessEvidence,
	options: SavedRuntimeProcessInspectionOptions = {},
): Promise<void> {
	const { pids, sessionPids, managed } = evidence;
	if (pids.size === 0) return;
	const snapshot = await (options.snapshot ?? queryOwnedProcessSnapshot)();
	const byPid = new Map(snapshot.filter((row) => !row.zombie).map((row) => [row.pid, row]));
	const blocked: number[] = [];
	for (const pid of pids) {
		const live = byPid.get(pid);
		if (!live) continue;
		const evidence = managed.filter((row) => row.rootProcess.pid === pid);
		// Exact Windows birth evidence can prove a PID was recycled; never kill the replacement.
		if (
			(options.platform ?? process.platform) === "win32" &&
			!sessionPids.has(pid) &&
			evidence.length > 0 &&
			live.preciseIdentity &&
			live.creationIdentity &&
			evidence.every((row) => row.rootProcess.creationTime !== live.creationIdentity)
		)
			continue;
		blocked.push(pid);
	}
	if (blocked.length)
		throw new RuntimeRecoveryAdmissionError(
			"live_prior_process",
			blocked.sort((a, b) => a - b),
		);
}

export function ordinaryRuntimeCustodyCleared(
	history: readonly PriorRuntimeProcessCustody[],
	currentBoot: string | null,
	acknowledgedBoundary: string | null = null,
): boolean {
	const boundaryIndex = history.findIndex((owner) => owner.claim.generation === acknowledgedBoundary);
	return history
		.slice(boundaryIndex + 1)
		.some(
			(owner) =>
				(owner.claim.purpose === "runtime" && owner.released) ||
				differentBoot(owner.claim.bootIdentity, currentBoot),
		);
}
