export interface AgentLabBrowserProcessIdentity {
	pid: number;
	pgid?: number;
	startTime: string | null;
	commandLine: string;
}

export interface AgentLabBrowserProcessRecord extends AgentLabBrowserProcessIdentity {
	ppid: number;
}

export interface AgentLabBrowserProcessTree {
	rootPids: number[];
	processPids: number[];
	identities?: AgentLabBrowserProcessIdentity[];
	/** Unix-only, verified owned group leaders. Never authorizes a group-wide signal. */
	groups?: AgentLabBrowserProcessIdentity[];
}

/** UTC 100ns units retain the full precision of Windows CreationDate. BSD ps is second precision. */
function birthTime(value: string | null): bigint | null {
	if (!value) return null;
	const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,7}))?(?:Z|\+00:00)$/u.exec(value);
	const unix =
		/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(
			value,
		);
	if (!iso && !unix) return null;
	const milliseconds = Date.parse(iso ? value : `${value} UTC`);
	if (!Number.isFinite(milliseconds)) return null;
	return BigInt(milliseconds) * 10_000n + BigInt((iso?.[1] ?? "").padEnd(7, "0").slice(3));
}

export function compareBrowserProcessBirth(
	child: AgentLabBrowserProcessIdentity,
	parent: AgentLabBrowserProcessIdentity,
): -1 | 0 | 1 | null {
	const left = birthTime(child.startTime);
	const right = birthTime(parent.startTime);
	if (left === null || right === null) return null;
	return left < right ? -1 : left > right ? 1 : 0;
}

export function sameBrowserProcess(
	left: AgentLabBrowserProcessIdentity,
	right: AgentLabBrowserProcessIdentity,
): boolean {
	return (
		left.startTime !== null &&
		left.startTime === right.startTime &&
		left.commandLine === right.commandLine &&
		(left.pgid === undefined || left.pgid === right.pgid)
	);
}

export function browserProcessIdentity(row: AgentLabBrowserProcessRecord): AgentLabBrowserProcessIdentity {
	return {
		pid: row.pid,
		...(row.pgid === undefined ? {} : { pgid: row.pgid }),
		startTime: row.startTime,
		commandLine: row.commandLine,
	};
}

export function assertBrowserOwnershipUnambiguous(ambiguous: ReadonlySet<number>): void {
	if (ambiguous.size > 0) {
		throw new Error(`Refusing ambiguous Agent Lab browser process identities for PIDs: ${[...ambiguous].join(", ")}`);
	}
}

function registerOwnedGroup(
	leader: AgentLabBrowserProcessIdentity,
	groups: Map<number, AgentLabBrowserProcessIdentity>,
	ambiguous: Set<number>,
): void {
	const previous = groups.get(leader.pid);
	if (
		leader.pgid !== leader.pid ||
		birthTime(leader.startTime) === null ||
		(previous && !sameBrowserProcess(previous, leader))
	)
		ambiguous.add(leader.pid);
	if (ambiguous.has(leader.pid)) groups.delete(leader.pid);
	else groups.set(leader.pid, leader);
}

export function browserOwnedGroups(
	tree: AgentLabBrowserProcessTree,
	platform: NodeJS.Platform,
	ambiguous: Set<number>,
): Map<number, AgentLabBrowserProcessIdentity> {
	const groups = new Map<number, AgentLabBrowserProcessIdentity>();
	// Windows parentage is not a durable orphan boundary. This harness has no
	// Job Object; never infer Windows orphan ownership from stale ParentProcessId.
	if (platform === "win32") return groups;
	const leaders = (tree.identities ?? []).filter(({ pid, pgid }) => pid === pgid && tree.processPids.includes(pid));
	for (const leader of [...(tree.groups ?? []), ...leaders]) registerOwnedGroup(leader, groups, ambiguous);
	for (const pid of ambiguous) groups.delete(pid);
	return groups;
}

/** Expands only proven ancestry or a previously verified owned Unix group. */
export function inspectBrowserOwnership(
	snapshot: readonly AgentLabBrowserProcessRecord[],
	owned: Map<number, AgentLabBrowserProcessIdentity>,
	groups: Map<number, AgentLabBrowserProcessIdentity>,
	ambiguous: Set<number>,
): number[] {
	const present = new Map(snapshot.map((row) => [row.pid, row]));
	const matching = new Set<number>();
	for (const [pid, identity] of owned) {
		const current = present.get(pid);
		if (!current || ambiguous.has(pid)) continue;
		if (sameBrowserProcess(identity, current) && birthTime(current.startTime) !== null) matching.add(pid);
		else ambiguous.add(pid);
	}
	const canAdopt = (child: AgentLabBrowserProcessRecord, parent: AgentLabBrowserProcessIdentity): boolean => {
		const order = compareBrowserProcessBirth(child, parent);
		if (order === null) ambiguous.add(child.pid);
		return order !== null && order >= 0;
	};
	let added = true;
	const adopt = (row: AgentLabBrowserProcessRecord) => {
		if (owned.has(row.pid) || ambiguous.has(row.pid)) return;
		const identity = browserProcessIdentity(row);
		// Playwright launches Chromium detached, in a group separate from the
		// daemon. Register that boundary only after proving the leader's ownership.
		if (row.pgid === row.pid) registerOwnedGroup(identity, groups, ambiguous);
		if (ambiguous.has(row.pid)) return;
		owned.set(row.pid, identity);
		matching.add(row.pid);
		added = true;
	};

	// Alternate group and ancestry expansion until no new process is admitted:
	// an owned descendant may itself lead a newly discoverable detached group.
	while (added) {
		added = false;
		for (const [pgid, leader] of groups) {
			const currentLeader = present.get(pgid);
			if (ambiguous.has(pgid) || (currentLeader && !sameBrowserProcess(leader, currentLeader))) {
				ambiguous.add(pgid);
				groups.delete(pgid);
				continue;
			}
			const members = snapshot.filter((row) => row.pgid === pgid);
			if (members.length === 0) {
				// An empty group has ended. Never reuse its boundary for a later group.
				groups.delete(pgid);
				continue;
			}
			if (members.some((row) => compareBrowserProcessBirth(row, leader) === -1)) {
				ambiguous.add(pgid);
				groups.delete(pgid);
				continue;
			}
			for (const row of members) {
				if (owned.has(row.pid) || ambiguous.has(row.pid)) continue;
				// Group discovery must not bypass a contradictory birth order merely
				// because ps listed the child before its parent.
				const parent = present.get(row.ppid);
				if (canAdopt(row, leader) && (!parent || canAdopt(row, parent))) adopt(row);
			}
		}
		for (const row of snapshot) {
			if (!matching.has(row.ppid) || owned.has(row.pid) || ambiguous.has(row.pid)) continue;
			const parent = present.get(row.ppid);
			if (!parent || !canAdopt(row, parent)) continue;
			adopt(row);
		}
	}
	return [...matching];
}
