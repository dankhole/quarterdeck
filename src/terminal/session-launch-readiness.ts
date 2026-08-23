import type { RuntimeHookMetadata } from "../core";

export type TaskSessionLaunchReadinessOutcome =
	| {
			status: "ready";
			sessionInstanceId: string;
			observedSessionId: string | null;
	  }
	| {
			status: "identity_mismatch";
			sessionInstanceId: string;
			expectedSessionId: string;
			observedSessionId: string;
	  }
	| {
			status: "exited";
			sessionInstanceId: string;
			exitCode: number | null;
	  }
	| {
			status: "cancelled" | "superseded" | "user_engaged";
			sessionInstanceId: string;
	  }
	| {
			status: "timeout";
			sessionInstanceId: string;
	  };

type SettledLaunchReadinessOutcome = Exclude<TaskSessionLaunchReadinessOutcome, { status: "timeout" }>;

export interface TaskSessionLaunchMonitor {
	sessionInstanceId: string;
	expectedSessionId: string | null;
	pid: number | null;
	outcome: SettledLaunchReadinessOutcome | null;
	waiters: Set<(outcome: SettledLaunchReadinessOutcome) => void>;
}

export function createTaskSessionLaunchMonitor(options: {
	sessionInstanceId: string;
	expectedSessionId?: string;
}): TaskSessionLaunchMonitor {
	return {
		sessionInstanceId: options.sessionInstanceId,
		expectedSessionId: options.expectedSessionId?.trim() || null,
		pid: null,
		outcome: null,
		waiters: new Set(),
	};
}

function settleTaskSessionLaunch(
	monitor: TaskSessionLaunchMonitor | null,
	outcome: SettledLaunchReadinessOutcome,
): void {
	if (!monitor || monitor.outcome) {
		return;
	}
	monitor.outcome = outcome;
	for (const waiter of monitor.waiters) {
		waiter(outcome);
	}
	monitor.waiters.clear();
}

export function markTaskSessionLaunchReady(
	monitor: TaskSessionLaunchMonitor | null,
	metadata: RuntimeHookMetadata | undefined,
): void {
	if (!monitor || monitor.outcome) {
		return;
	}
	const incomingInstanceId = metadata?.sessionInstanceId?.trim() || null;
	if (!incomingInstanceId || incomingInstanceId !== monitor.sessionInstanceId) {
		return;
	}
	const observedSessionId = metadata?.sessionId?.trim() || null;
	if (monitor.expectedSessionId) {
		if (!observedSessionId) {
			return;
		}
		if (observedSessionId !== monitor.expectedSessionId) {
			settleTaskSessionLaunch(monitor, {
				status: "identity_mismatch",
				sessionInstanceId: monitor.sessionInstanceId,
				expectedSessionId: monitor.expectedSessionId,
				observedSessionId,
			});
			return;
		}
	}
	settleTaskSessionLaunch(monitor, {
		status: "ready",
		sessionInstanceId: monitor.sessionInstanceId,
		observedSessionId,
	});
}

export function markTaskSessionLaunchExited(monitor: TaskSessionLaunchMonitor | null, exitCode: number | null): void {
	if (!monitor) {
		return;
	}
	settleTaskSessionLaunch(monitor, {
		status: "exited",
		sessionInstanceId: monitor.sessionInstanceId,
		exitCode,
	});
}

export function markTaskSessionLaunchCancelled(monitor: TaskSessionLaunchMonitor | null): void {
	if (!monitor) {
		return;
	}
	settleTaskSessionLaunch(monitor, {
		status: "cancelled",
		sessionInstanceId: monitor.sessionInstanceId,
	});
}

export function markTaskSessionLaunchSuperseded(monitor: TaskSessionLaunchMonitor | null): void {
	if (!monitor) {
		return;
	}
	settleTaskSessionLaunch(monitor, {
		status: "superseded",
		sessionInstanceId: monitor.sessionInstanceId,
	});
}

export function markTaskSessionLaunchUserEngaged(monitor: TaskSessionLaunchMonitor | null): void {
	if (!monitor) {
		return;
	}
	settleTaskSessionLaunch(monitor, {
		status: "user_engaged",
		sessionInstanceId: monitor.sessionInstanceId,
	});
}

export async function waitForTaskSessionLaunchReadiness(
	monitor: TaskSessionLaunchMonitor,
	timeoutMs: number,
): Promise<TaskSessionLaunchReadinessOutcome> {
	if (monitor.outcome) {
		return monitor.outcome;
	}
	return await new Promise<TaskSessionLaunchReadinessOutcome>((resolve) => {
		let settled = false;
		const complete = (outcome: TaskSessionLaunchReadinessOutcome) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			monitor.waiters.delete(onSettled);
			resolve(outcome);
		};
		const onSettled = (outcome: SettledLaunchReadinessOutcome) => complete(outcome);
		const timeout = setTimeout(
			() => {
				complete({
					status: "timeout",
					sessionInstanceId: monitor.sessionInstanceId,
				});
			},
			Math.max(0, timeoutMs),
		);
		monitor.waiters.add(onSettled);
		if (monitor.outcome) {
			complete(monitor.outcome);
		}
	});
}
