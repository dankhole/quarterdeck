import { access } from "node:fs/promises";

const MAX_ACTIVE_PATH_CHECKS = 2;
const DEFAULT_PATH_CHECK_DEADLINE_MS = 2_000;

type PathCheckResult = boolean | null;

interface PathCheckConsumer {
	complete: (result: PathCheckResult) => void;
	deadlineAt: number;
}

interface PathCheck {
	path: string;
	started: boolean;
	consumers: Set<PathCheckConsumer>;
}

// Only running OS operations survive their last consumer's deadline. Node's
// access cannot cancel them; keeping their slots prevents unbounded hung I/O.
const checksByPath = new Map<string, PathCheck>();
const queuedChecks: PathCheck[] = [];
let activeChecks = 0;

async function runPathCheck(check: PathCheck): Promise<void> {
	let exists = false;
	try {
		await access(check.path);
		exists = true;
	} catch {
		// Match existsSync: filesystem errors mean the path is unavailable.
	}
	checksByPath.delete(check.path);
	activeChecks -= 1;
	const consumers = [...check.consumers];
	check.consumers.clear();
	for (const consumer of consumers) consumer.complete(exists);
	startQueuedChecks();
}

function startQueuedChecks(): void {
	while (activeChecks < MAX_ACTIVE_PATH_CHECKS && queuedChecks.length > 0) {
		const check = queuedChecks.shift();
		if (!check) break;
		for (const consumer of check.consumers) {
			if (consumer.deadlineAt <= Date.now()) {
				check.consumers.delete(consumer);
				consumer.complete(null);
			}
		}
		if (check.consumers.size === 0) {
			checksByPath.delete(check.path);
			continue;
		}
		check.started = true;
		activeChecks += 1;
		void runPathCheck(check);
	}
}

function subscribeToPathCheck(
	path: string,
	deadlineAt: number,
): { result: Promise<PathCheckResult>; cancel: () => void } {
	let check = checksByPath.get(path);
	if (check?.started) {
		// This operation predates the caller's launch capture. Its eventual
		// result must not diagnose a replacement PTY, even at the same path.
		return { result: Promise.resolve(null), cancel: () => {} };
	}
	if (!check) {
		check = { path, started: false, consumers: new Set() };
		checksByPath.set(path, check);
		queuedChecks.push(check);
	}
	const subscribedCheck = check;
	let consumer!: PathCheckConsumer;
	const result = new Promise<PathCheckResult>((complete) => {
		consumer = { complete, deadlineAt };
		subscribedCheck.consumers.add(consumer);
	});
	const cancel = () => {
		if (!subscribedCheck.consumers.delete(consumer)) return;
		consumer.complete(null);
		if (!subscribedCheck.started && subscribedCheck.consumers.size === 0) {
			queuedChecks.splice(queuedChecks.indexOf(subscribedCheck), 1);
			checksByPath.delete(path);
		}
	};
	startQueuedChecks();
	return { result, cancel };
}

/** Deadline/overload is unknown, never evidence that a launch folder is gone. */
export async function probeSessionLaunchPaths(
	paths: readonly string[],
	deadlineMs = DEFAULT_PATH_CHECK_DEADLINE_MS,
): Promise<Map<string, PathCheckResult>> {
	const uniquePaths = [...new Set(paths)];
	const results = new Map<string, PathCheckResult>(uniquePaths.map((path) => [path, null]));
	if (uniquePaths.length === 0) return results;

	let expired = false;
	const deadlineAt = Date.now() + deadlineMs;
	let nextPath = 0;
	const cancellations = new Set<() => void>();
	const timer = setTimeout(() => {
		expired = true;
		for (const cancel of cancellations) cancel();
	}, deadlineMs);
	timer.unref();

	async function feedPaths(): Promise<void> {
		while (!expired && Date.now() < deadlineAt && nextPath < uniquePaths.length) {
			const path = uniquePaths[nextPath++];
			if (path === undefined) break;
			const subscription = subscribeToPathCheck(path, deadlineAt);
			cancellations.add(subscription.cancel);
			const result = await subscription.result;
			cancellations.delete(subscription.cancel);
			if (!expired && Date.now() < deadlineAt) results.set(path, result);
		}
	}

	try {
		// At most two queued subscriptions per live batch, not one per path.
		await Promise.all([feedPaths(), feedPaths()]);
		return results;
	} finally {
		clearTimeout(timer);
	}
}
