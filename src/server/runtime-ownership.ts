import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { link, lstat, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
	type PublicRuntimeOwnerDescriptor,
	publicRuntimeOwnerDescriptorSchema,
	QUARTERDECK_MANAGEMENT_PROTOCOL_VERSION,
	type RuntimeOwnerDescriptor,
	type RuntimeOwnershipClaim,
	type RuntimeTransportCapabilities,
	runtimeOwnerDescriptorSchema,
	runtimeOwnershipClaimSchema,
} from "../core/api/runtime-management.js";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../core/api/runtime-protocol.js";
import { normalizeFileSystemPathForComparison } from "../core/path-comparison.js";
import { ensurePrivateDirectories } from "../core/private-directory.js";
import { readRuntimeBootIdentity } from "./runtime-boot-identity.js";
import {
	inspectRuntimeProcess,
	probeRuntimeProcess,
	type RuntimeProcessLiveness,
	readRuntimeHostIdentity,
	readRuntimeProcessIdentity,
} from "./runtime-process-identity.js";

const OWNERSHIP_DIRECTORY = "runtime-ownership";
const MAX_CLAIM_DEPTH = 100_000;
const MONITOR_INTERVAL_MS = 1_000;
const MAX_CLAIM_BYTES = 16_384;

export type RuntimeOwnershipErrorCode =
	| "invalid_claim"
	| "legacy_live_owner"
	| "ownership_lost"
	| "maintenance_busy"
	| "identity_unavailable"
	| "unsupported_filesystem";

export class RuntimeOwnershipError extends Error {
	constructor(
		readonly code: RuntimeOwnershipErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RuntimeOwnershipError";
	}
}

export interface DiscoveredRuntimeOwner {
	claim: RuntimeOwnershipClaim;
	descriptor: RuntimeOwnerDescriptor | null;
	processState: RuntimeProcessLiveness;
	released: boolean;
}

export interface AcquireRuntimeOwnershipOptions {
	stateHome: string;
	purpose?: RuntimeOwnershipClaim["purpose"];
	quarterdeckVersion: string;
	runtimeProtocolVersion?: number;
	capabilities?: RuntimeTransportCapabilities;
	onOwnershipLost?: () => void;
}

export type RuntimeOwnershipAdmission =
	| { kind: "acquired"; lease: RuntimeOwnershipLease }
	| { kind: "occupied"; owner: DiscoveredRuntimeOwner };

interface ClaimSnapshot {
	claim: RuntimeOwnershipClaim;
	path: string;
	released: boolean;
	history: RuntimeOwnershipClaim[];
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function resolveHostIdentity(): Promise<string> {
	try {
		return await readRuntimeHostIdentity();
	} catch {
		throw new RuntimeOwnershipError(
			"identity_unavailable",
			"Could not verify this machine's stable runtime identity.",
		);
	}
}

/** Resolves existing symlinks even when the requested home does not exist yet. */
export async function resolveCanonicalRuntimeStateHome(stateHome: string): Promise<string> {
	let existing = resolve(stateHome);
	const suffix: string[] = [];
	for (;;) {
		try {
			return normalizeFileSystemPathForComparison(join(await realpath(existing), ...suffix));
		} catch (error) {
			if (!isMissing(error) || dirname(existing) === existing) throw error;
			suffix.unshift(basename(existing));
			existing = dirname(existing);
		}
	}
}

function rootPath(home: string): string {
	return join(home, OWNERSHIP_DIRECTORY);
}
function successorPath(root: string, generation: string): string {
	return join(root, "successors", `${generation}.json`);
}
function releasePath(root: string, generation: string): string {
	return join(root, "released", `${generation}.json`);
}
function descriptorPath(root: string, generation: string): string {
	return join(root, "descriptors", `${generation}.json`);
}
function custodyDirtyPath(root: string, generation: string): string {
	return join(root, "custody-dirty", `${generation}.json`);
}

async function readClaim(path: string, home: string, hostIdentity: string): Promise<RuntimeOwnershipClaim | null> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLAIM_BYTES)
			throw new Error("Invalid claim file.");
		const claim = runtimeOwnershipClaimSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
		if (claim.canonicalStateHome !== home || claim.hostIdentity !== hostIdentity)
			throw new Error("Claim belongs to another home or host.");
		return claim;
	} catch (error) {
		if (isMissing(error)) return null;
		throw new RuntimeOwnershipError(
			"invalid_claim",
			"Runtime ownership evidence is unreadable. Stop all runtimes before repairing ownership storage.",
		);
	}
}

async function readCurrentClaim(home: string, hostIdentity: string): Promise<ClaimSnapshot | null> {
	const root = rootPath(home);
	let path = join(root, "first-owner.json");
	let claim = await readClaim(path, home, hostIdentity);
	if (!claim) {
		let existingHistory = false;
		for (const directory of [join(root, "successors"), join(root, "released"), join(root, "custody-dirty")]) {
			try {
				if ((await readdir(directory)).some((entry) => !entry.startsWith("."))) existingHistory = true;
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
		if (!existingHistory) return null;
		claim = await readClaim(path, home, hostIdentity);
		if (!claim)
			throw new RuntimeOwnershipError("invalid_claim", "Runtime ownership history is missing its root claim.");
	}
	if (claim.previousGeneration !== null)
		throw new RuntimeOwnershipError("invalid_claim", "Runtime ownership root has an invalid predecessor.");
	const visited = new Set<string>();
	const history: RuntimeOwnershipClaim[] = [];
	for (let depth = 0; depth < MAX_CLAIM_DEPTH; depth++) {
		if (visited.has(claim.generation)) break;
		visited.add(claim.generation);
		history.push(claim);
		const nextPath = successorPath(root, claim.generation);
		let next = await readClaim(nextPath, home, hostIdentity);
		if (!next) {
			// A missing predecessor edge must not hide another reachable owner's descendants.
			const unreachable = (await readdir(join(root, "successors"))).some(
				(entry) => !entry.startsWith(".") && (!entry.endsWith(".json") || !visited.has(entry.slice(0, -5))),
			);
			if (unreachable) {
				// A legitimate rapid successor may have appeared after our first read.
				next = await readClaim(nextPath, home, hostIdentity);
				if (!next)
					throw new RuntimeOwnershipError(
						"invalid_claim",
						"Runtime ownership history contains an unreachable claim.",
					);
			}
			if (!next) {
				const released = await readClaim(releasePath(root, claim.generation), home, hostIdentity);
				if (released && JSON.stringify(released) !== JSON.stringify(claim)) break;
				return { claim, path, released: released !== null, history };
			}
		}
		if (next.previousGeneration !== claim.generation) break;
		claim = next;
		path = nextPath;
	}
	throw new RuntimeOwnershipError(
		"invalid_claim",
		"Runtime ownership history is corrupt or exceeds its supported depth.",
	);
}

async function readDescriptor(root: string, claim: RuntimeOwnershipClaim): Promise<RuntimeOwnerDescriptor | null> {
	try {
		const path = descriptorPath(root, claim.generation);
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLAIM_BYTES) return null;
		const descriptor = runtimeOwnerDescriptorSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
		return descriptor.generation === claim.generation &&
			descriptor.canonicalStateHome === claim.canonicalStateHome &&
			descriptor.process.pid === claim.process.pid &&
			descriptor.process.creationIdentity === claim.process.creationIdentity
			? descriptor
			: null;
	} catch {
		return null;
	}
}

/** Discovery is read-only, including when the home has never been created. */
export async function discoverRuntimeOwner(stateHome: string): Promise<DiscoveredRuntimeOwner | null> {
	const home = await resolveCanonicalRuntimeStateHome(stateHome);
	const current = await readCurrentClaim(home, await resolveHostIdentity());
	if (!current) return null;
	return {
		claim: current.claim,
		descriptor: await readDescriptor(rootPath(home), current.claim),
		processState: await inspectRuntimeProcess(current.claim.process),
		released: current.released,
	};
}

/** Prior generations, oldest first, provide read-only recovery evidence and boot observation anchors. */
export async function readPriorRuntimeOwnershipClaims(
	stateHome: string,
	currentGeneration: string,
): Promise<Array<{ claim: RuntimeOwnershipClaim; released: boolean; custodyDirty: boolean | null }>> {
	const home = await resolveCanonicalRuntimeStateHome(stateHome);
	const hostIdentity = await resolveHostIdentity();
	const current = await readCurrentClaim(home, hostIdentity);
	if (!current || current.claim.generation !== currentGeneration)
		throw new RuntimeOwnershipError("ownership_lost", "Runtime recovery requires the current ownership generation.");
	const prior: Array<{ claim: RuntimeOwnershipClaim; released: boolean; custodyDirty: boolean | null }> = [];
	for (const claim of current.history.slice(0, -1)) {
		const released = await readClaim(releasePath(rootPath(home), claim.generation), home, hostIdentity);
		if (released && JSON.stringify(released) !== JSON.stringify(claim))
			throw new RuntimeOwnershipError("invalid_claim", "Runtime ownership release evidence is inconsistent.");
		const dirty = await readClaim(custodyDirtyPath(rootPath(home), claim.generation), home, hostIdentity);
		if (dirty && (claim.custodyProtocolVersion !== 1 || JSON.stringify(dirty) !== JSON.stringify(claim)))
			throw new RuntimeOwnershipError("invalid_claim", "Runtime process custody evidence is inconsistent.");
		prior.push({
			claim,
			released: released !== null,
			custodyDirty: claim.custodyProtocolVersion === 1 ? dirty !== null : null,
		});
	}
	return prior;
}

/** Legacy descriptors have no birth evidence, so only a proven absent PID is safe. */
async function refuseLiveLegacyOwners(
	home: string,
	history: readonly RuntimeOwnershipClaim[],
	hostIdentity: string,
): Promise<void> {
	const instances = join(home, "diagnostics", "instances");
	let entries: string[];
	try {
		entries = await readdir(instances);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	for (const entry of entries) {
		let descriptor: unknown;
		try {
			descriptor = JSON.parse(await readFile(join(instances, entry, "runtime.json"), "utf8"));
		} catch {
			continue;
		}
		if (
			typeof descriptor !== "object" ||
			descriptor === null ||
			!("pid" in descriptor) ||
			typeof descriptor.pid !== "number" ||
			!Number.isSafeInteger(descriptor.pid) ||
			descriptor.pid <= 0
		)
			continue;
		// A desktop journal describes the supervising GUI, not a durable runtime writer.
		if ("processKind" in descriptor && descriptor.processKind === "desktop") continue;
		let confirmedReleased = false;
		for (const claim of history) {
			if (claim.process.pid !== descriptor.pid) continue;
			const released = await readClaim(releasePath(rootPath(home), claim.generation), home, hostIdentity);
			if (
				released &&
				JSON.stringify(released) === JSON.stringify(claim) &&
				(await inspectRuntimeProcess(claim.process)) === "live"
			) {
				confirmedReleased = true;
				break;
			}
		}
		// A reachable immutable release plus current birth identity proves this
		// still-live process has quiesced. A diagnostic status alone never does.
		if (confirmedReleased) continue;
		if (probeRuntimeProcess(descriptor.pid) !== "dead") {
			throw new RuntimeOwnershipError(
				"legacy_live_owner",
				"A runtime without current ownership admission may still be active. Stop or upgrade it before launching another runtime for this state home.",
			);
		}
	}
}

async function syncDirectory(path: string): Promise<void> {
	// Windows does not support opening directories through fs.open. File sync still precedes publication.
	if (process.platform === "win32") return;
	const file = await open(path, "r");
	try {
		await file.sync();
	} finally {
		await file.close();
	}
}

/** Publishes complete bytes with an atomic, non-replacing hard link. */
async function publishExclusive(path: string, value: unknown): Promise<boolean> {
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temporary, path);
		await syncDirectory(dirname(path));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes((error as NodeJS.ErrnoException).code ?? ""))
			throw new RuntimeOwnershipError(
				"unsupported_filesystem",
				"Runtime ownership requires atomic hard links on a local filesystem.",
			);
		throw error;
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

/** Covered spawn boundaries are synchronous: custody evidence must be durable before they run. */
function publishCustodyDirty(path: string, claim: RuntimeOwnershipClaim): void {
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	const file = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(file, `${JSON.stringify(claim)}\n`, "utf8");
		fsyncSync(file);
	} finally {
		closeSync(file);
	}
	try {
		try {
			linkSync(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stat = lstatSync(path);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.size > MAX_CLAIM_BYTES ||
				JSON.stringify(runtimeOwnershipClaimSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown)) !==
					JSON.stringify(claim)
			)
				throw new RuntimeOwnershipError("invalid_claim", "Runtime process custody evidence is inconsistent.");
		}
		if (process.platform !== "win32") {
			const directory = openSync(dirname(path), "r");
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		}
	} catch (error) {
		if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes((error as NodeJS.ErrnoException).code ?? ""))
			throw new RuntimeOwnershipError(
				"unsupported_filesystem",
				"Runtime ownership requires local filesystem hard-link support.",
			);
		throw error;
	} finally {
		unlinkSync(temporary);
	}
}

async function persistDescriptor(path: string, descriptor: RuntimeOwnerDescriptor): Promise<void> {
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
		await syncDirectory(dirname(path));
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && right.isFile();
}

export class RuntimeOwnershipLease {
	readonly canonicalStateHome: string;
	readonly generation: string;
	readonly bootIdentity: string | null;
	private closed = false;
	private lost = false;
	private monitor: NodeJS.Timeout;
	private descriptor: RuntimeOwnerDescriptor | null;
	private readonly firstFile: Stats;
	private readonly claimFile: Stats;
	private persistQueue = Promise.resolve();
	private custodyMarked = false;
	private releasePromise: Promise<void> | null = null;

	constructor(
		private readonly claim: RuntimeOwnershipClaim,
		private readonly claimPath: string,
		descriptor: RuntimeOwnerDescriptor | null,
		private readonly onOwnershipLost: () => void,
	) {
		this.canonicalStateHome = claim.canonicalStateHome;
		this.generation = claim.generation;
		this.bootIdentity = claim.bootIdentity ?? null;
		this.descriptor = descriptor;
		this.firstFile = lstatSync(join(rootPath(this.canonicalStateHome), "first-owner.json"));
		this.claimFile = lstatSync(claimPath);
		this.monitor = setInterval(() => {
			this.isCurrent();
		}, MONITOR_INTERVAL_MS);
		this.monitor.unref();
	}

	isCurrent(): boolean {
		if (this.closed || this.lost) return false;
		try {
			const root = rootPath(this.canonicalStateHome);
			if (
				!sameFile(this.firstFile, lstatSync(join(root, "first-owner.json"))) ||
				!sameFile(this.claimFile, lstatSync(this.claimPath))
			)
				throw new Error();
			for (const path of [successorPath(root, this.generation), releasePath(root, this.generation)]) {
				try {
					lstatSync(path);
					throw new Error("Ownership superseded.");
				} catch (error) {
					if (!isMissing(error)) throw error;
				}
			}
			return true;
		} catch {
			this.lost = true;
			clearInterval(this.monitor);
			this.onOwnershipLost();
			return false;
		}
	}

	assertCurrent(): void {
		if (!this.isCurrent())
			throw new RuntimeOwnershipError("ownership_lost", "Runtime no longer owns this state home.");
	}

	/** Call immediately before every covered managed host spawn; the first call publishes the one-way marker. */
	markProcessCustodyDirty(): void {
		this.assertCurrent();
		if (!this.custodyMarked) {
			publishCustodyDirty(custodyDirtyPath(rootPath(this.canonicalStateHome), this.generation), this.claim);
			this.custodyMarked = true;
		}
		this.assertCurrent();
	}

	getDescriptor(): RuntimeOwnerDescriptor | null {
		return structuredClone(this.descriptor);
	}
	getPublicDescriptor(): PublicRuntimeOwnerDescriptor | null {
		return this.descriptor ? publicRuntimeOwnerDescriptorSchema.parse(this.descriptor) : null;
	}

	verifyManagementToken(token: string | undefined, generation: string | undefined): boolean {
		if (!token || generation !== this.generation || !this.isCurrent() || !this.descriptor) return false;
		const expected = Buffer.from(this.descriptor.managementToken);
		const received = Buffer.from(token);
		return expected.length === received.length && timingSafeEqual(expected, received);
	}

	markReady(endpoint: { host: string; port: number }): Promise<void> {
		return this.updateDescriptor({ status: "ready", endpoint, readyAt: new Date().toISOString() });
	}

	markStopping(): Promise<void> {
		return this.updateDescriptor({ status: "stopping" });
	}

	private updateDescriptor(patch: Partial<RuntimeOwnerDescriptor>): Promise<void> {
		this.persistQueue = this.persistQueue.then(async () => {
			this.assertCurrent();
			if (!this.descriptor) throw new Error("Maintenance leases have no runtime descriptor.");
			const descriptor = runtimeOwnerDescriptorSchema.parse({ ...this.descriptor, ...patch });
			await persistDescriptor(descriptorPath(rootPath(this.canonicalStateHome), this.generation), descriptor);
			this.assertCurrent();
			this.descriptor = descriptor;
		});
		return this.persistQueue;
	}

	/** Caller must already have drained writes, owned processes, and server closure. */
	release(): Promise<void> {
		if (this.releasePromise) return this.releasePromise;
		this.releasePromise = (async () => {
			this.assertCurrent();
			this.closed = true;
			clearInterval(this.monitor);
			await this.persistQueue.catch(() => undefined);
			await publishExclusive(releasePath(rootPath(this.canonicalStateHome), this.generation), this.claim);
		})();
		return this.releasePromise;
	}
}

export async function acquireRuntimeOwnership(
	options: AcquireRuntimeOwnershipOptions,
): Promise<RuntimeOwnershipAdmission> {
	const home = await resolveCanonicalRuntimeStateHome(options.stateHome);
	const root = rootPath(home);
	const hostIdentity = await resolveHostIdentity();
	const bootIdentity = await readRuntimeBootIdentity();
	const processIdentity = await readRuntimeProcessIdentity(process.pid).catch(() => null);
	if (!processIdentity)
		throw new RuntimeOwnershipError(
			"identity_unavailable",
			"Could not verify this runtime's process creation identity.",
		);
	// Never allow an ownership directory symlink to redirect this home's claim.
	for (const path of [
		root,
		join(root, "successors"),
		join(root, "released"),
		join(root, "descriptors"),
		join(root, "custody-dirty"),
	]) {
		try {
			if ((await lstat(path)).isSymbolicLink())
				throw new RuntimeOwnershipError("invalid_claim", "Runtime ownership storage must not be a symbolic link.");
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	await ensurePrivateDirectories([
		root,
		join(root, "successors"),
		join(root, "released"),
		join(root, "descriptors"),
		join(root, "custody-dirty"),
	]);
	const claim: RuntimeOwnershipClaim = {
		version: 1,
		generation: randomUUID(),
		canonicalStateHome: home,
		hostIdentity,
		custodyProtocolVersion: 1,
		bootIdentity,
		previousGeneration: null,
		purpose: options.purpose ?? "runtime",
		process: processIdentity,
		claimedAt: new Date().toISOString(),
	};
	const descriptor =
		claim.purpose === "runtime"
			? runtimeOwnerDescriptorSchema.parse({
					version: 1,
					generation: claim.generation,
					canonicalStateHome: home,
					process: processIdentity,
					status: "starting",
					endpoint: null,
					quarterdeckVersion: options.quarterdeckVersion,
					runtimeProtocolVersion: options.runtimeProtocolVersion ?? QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
					managementProtocolVersion: QUARTERDECK_MANAGEMENT_PROTOCOL_VERSION,
					capabilities: options.capabilities ?? {
						transportVersion: 1,
						browserHttp: true,
						browserWebSocket: true,
						desktopProxy: false,
						desktopBridgeVersion: null,
					},
					startedAt: claim.claimedAt,
					readyAt: null,
					managementToken: randomBytes(32).toString("base64url"),
				})
			: null;
	let descriptorPublished = false;
	for (;;) {
		const current = await readCurrentClaim(home, hostIdentity);
		if (current && !current.released && (await inspectRuntimeProcess(current.claim.process)) !== "dead") {
			if (descriptorPublished) await unlink(descriptorPath(root, claim.generation));
			return {
				kind: "occupied",
				owner: {
					claim: current.claim,
					descriptor: await readDescriptor(root, current.claim),
					processState: await inspectRuntimeProcess(current.claim.process),
					released: false,
				},
			};
		}
		await refuseLiveLegacyOwners(home, current?.history ?? [], hostIdentity);
		const path = current ? successorPath(root, current.claim.generation) : join(root, "first-owner.json");
		claim.previousGeneration = current?.claim.generation ?? null;
		// Descriptor persistence must succeed before the claim becomes authoritative.
		if (descriptor && !descriptorPublished) {
			await persistDescriptor(descriptorPath(root, claim.generation), descriptor);
			descriptorPublished = true;
		}
		if (!(await publishExclusive(path, claim))) continue;
		const lease = new RuntimeOwnershipLease(claim, path, descriptor, options.onOwnershipLost ?? (() => undefined));
		lease.assertCurrent();
		return { kind: "acquired", lease };
	}
}

/** Offline writers participate in the same lifetime admission as runtime launchers. */
export async function withRuntimeMaintenance<T>(
	stateHome: string,
	operation: (lease: RuntimeOwnershipLease) => Promise<T>,
): Promise<T> {
	const admission = await acquireRuntimeOwnership({
		stateHome,
		quarterdeckVersion: "maintenance",
		purpose: "maintenance",
	});
	if (admission.kind === "occupied")
		throw new RuntimeOwnershipError("maintenance_busy", "Stop the runtime before modifying its state home offline.");
	try {
		return await operation(admission.lease);
	} finally {
		await admission.lease.release();
	}
}
