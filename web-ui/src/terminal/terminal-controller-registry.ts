import type { TerminalPasteOptions } from "@/terminal/terminal-input";

export interface TerminalController {
	input: (text: string) => boolean;
	paste: (text: string, options?: TerminalPasteOptions) => boolean;
	focus?: () => void;
	waitForLikelyPrompt?: (timeoutMs: number) => Promise<boolean>;
}

export interface TerminalControllerScope {
	projectId: string;
	sessionInstanceId: string;
	/** Expected PTY start timestamp; an exact waiter must not accept a pre-commit registration. */
	sessionStartedAt?: number | null;
}

/** One mounted viewer, independent of the longer-lived runtime session. */
export interface TerminalControllerAttachment {
	readonly controller: TerminalController;
	readonly signal: AbortSignal;
	readonly ready: boolean;
}

interface RegisteredTerminalController extends TerminalControllerAttachment {
	scope: TerminalControllerScope;
	ready: boolean;
	dispose: () => void;
}

type SubscribeToReadiness = (onReadyChange: (ready: boolean) => void) => () => void;
const controllersByTaskId = new Map<string, RegisteredTerminalController>();
const listenersByTaskId = new Map<string, Set<() => void>>();

function notify(taskId: string): void {
	for (const listener of listenersByTaskId.get(taskId) ?? []) listener();
}

export function getTerminalControllerAttachment(
	taskId: string,
	scope?: Pick<TerminalControllerScope, "projectId"> & Partial<Omit<TerminalControllerScope, "projectId">>,
): TerminalControllerAttachment | null {
	const registered = controllersByTaskId.get(taskId);
	if (!registered) return null;
	if (
		scope &&
		(registered.scope.projectId !== scope.projectId ||
			(scope.sessionInstanceId !== undefined && registered.scope.sessionInstanceId !== scope.sessionInstanceId) ||
			(scope.sessionStartedAt !== undefined && registered.scope.sessionStartedAt !== scope.sessionStartedAt))
	) {
		return null;
	}
	return registered;
}

export function getTerminalController(
	taskId: string,
	scope?: Pick<TerminalControllerScope, "projectId"> & Partial<Omit<TerminalControllerScope, "projectId">>,
): TerminalController | null {
	return getTerminalControllerAttachment(taskId, scope)?.controller ?? null;
}

/** Wait for both an exact registration and its replayable transport readiness; never poll task-only tokens. */
export function waitForTerminalController(
	taskId: string,
	scope: TerminalControllerScope,
	{ signal, isCurrent, timeoutMs = 2500 }: { signal: AbortSignal; isCurrent: () => boolean; timeoutMs?: number },
): Promise<TerminalControllerAttachment | null> {
	return new Promise((resolve) => {
		const listeners = listenersByTaskId.get(taskId) ?? new Set<() => void>();
		listenersByTaskId.set(taskId, listeners);
		const finish = (attachment: TerminalControllerAttachment | null) => {
			clearTimeout(timer);
			listeners.delete(check);
			if (listeners.size === 0 && listenersByTaskId.get(taskId) === listeners) listenersByTaskId.delete(taskId);
			signal.removeEventListener("abort", cancel);
			resolve(attachment);
		};
		const cancel = () => finish(null);
		const check = () => {
			if (signal.aborted || !isCurrent()) return finish(null);
			const attachment = getTerminalControllerAttachment(taskId, scope);
			if (attachment?.ready) finish(attachment);
		};
		const timer = setTimeout(cancel, timeoutMs);
		listeners.add(check);
		signal.addEventListener("abort", cancel, { once: true });
		check();
	});
}

export function registerTerminalController(
	taskId: string,
	controller: TerminalController,
	scope: TerminalControllerScope,
	subscribeToReadiness?: SubscribeToReadiness,
): () => void {
	controllersByTaskId.get(taskId)?.dispose();
	const lifetime = new AbortController();
	let unsubscribe: (() => void) | undefined;
	const registration: RegisteredTerminalController = {
		controller,
		scope,
		signal: lifetime.signal,
		// Direct/synthetic controllers are immediately writable. Transport-backed viewers subscribe explicitly.
		ready: subscribeToReadiness === undefined,
		dispose: () => {
			if (lifetime.signal.aborted) return;
			lifetime.abort();
			unsubscribe?.();
			if (controllersByTaskId.get(taskId) === registration) {
				controllersByTaskId.delete(taskId);
				notify(taskId);
			}
		},
	};
	controllersByTaskId.set(taskId, registration);
	unsubscribe = subscribeToReadiness?.((ready) => {
		if (controllersByTaskId.get(taskId) !== registration || lifetime.signal.aborted) return;
		registration.ready = ready;
		notify(taskId);
	});
	if (lifetime.signal.aborted) unsubscribe?.();
	notify(taskId);
	return registration.dispose;
}
