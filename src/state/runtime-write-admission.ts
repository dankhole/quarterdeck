import { isAbsolute, relative, resolve, sep } from "node:path";

export interface RuntimeWriteAdmissionOptions {
	canonicalStateHome: string;
	isCurrent: () => boolean;
}

interface InstalledAdmission {
	options: RuntimeWriteAdmissionOptions;
	pending: number;
	waiters: Set<() => void>;
}

const admissions = new Map<string, InstalledAdmission>();
// These stores have their own generation/launch scope and must survive model fencing.
const INDEPENDENT_STORES = new Set(["diagnostics", "hook-transition-outbox", "runtime-ownership", "managed-processes"]);

export class RuntimeWriteAdmissionError extends Error {
	readonly code = "RuntimeWriteAdmissionDenied";
	constructor() {
		super("Runtime ownership is no longer current; saved state cannot be changed.");
		this.name = "RuntimeWriteAdmissionError";
	}
}

function pathKey(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function matchingAdmissions(paths: readonly string[]): InstalledAdmission[] {
	return [...admissions.entries()]
		.filter(([home]) =>
			paths.some((path) => {
				const inside = relative(home, pathKey(path));
				if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false;
				return !INDEPENDENT_STORES.has(inside.split(sep)[0] ?? "");
			}),
		)
		.map(([, admission]) => admission);
}

/** Installed only by admitted production runtime/maintenance owners; factories remain unfenced. */
export function installRuntimeWriteAdmission(options: RuntimeWriteAdmissionOptions): () => void {
	const key = pathKey(options.canonicalStateHome);
	if (admissions.has(key)) throw new Error("Runtime write admission is already installed for this state home.");
	const admission: InstalledAdmission = { options, pending: 0, waiters: new Set() };
	admissions.set(key, admission);
	return () => {
		if (admission.pending !== 0) throw new Error("Runtime writes have not quiesced.");
		if (admissions.get(key) === admission) admissions.delete(key);
	};
}

/** Synchronous boundary check, including immediately before rename/remove commits. */
export function assertRuntimeWriteAdmission(path: string): void {
	for (const admission of matchingAdmissions([path])) {
		let current = false;
		try {
			current = admission.options.isCurrent();
		} catch {
			/* Unverifiable ownership denies writes. */
		}
		if (!current) throw new RuntimeWriteAdmissionError();
	}
}

/** Count admitted filesystem work so clean shutdown cannot release an active writer. */
export async function withRuntimeWriteOperation<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
	for (const path of paths) assertRuntimeWriteAdmission(path);
	const owners = matchingAdmissions(paths);
	for (const owner of owners) owner.pending += 1;
	try {
		return await operation();
	} finally {
		for (const owner of owners) {
			owner.pending -= 1;
			if (owner.pending === 0) {
				for (const resolveWaiter of owner.waiters) resolveWaiter();
				owner.waiters.clear();
			}
		}
	}
}

export async function waitForRuntimeWriteQuiescence(canonicalStateHome: string): Promise<void> {
	const owner = admissions.get(pathKey(canonicalStateHome));
	if (!owner || owner.pending === 0) return;
	await new Promise<void>((resolveWaiter) => owner.waiters.add(resolveWaiter));
}
