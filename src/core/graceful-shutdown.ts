/*
A single Ctrl+C can deliver multiple SIGINTs. Launch-path and npm-environment
heuristics cannot prove that a direct invocation receives only one signal, so
all launches suppress copies of the initial signal for a short, fixed window.
A later interrupt or a different signal still forces exit. Programmatic shutdown
also tolerates any signal racing its initial request. The shutdown deadline is
independent of duplicate delivery and never extends when another signal arrives.
*/
const DEFAULT_HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGBREAK"] as const;
const DEFAULT_DUPLICATE_SIGNAL_WINDOW_MS = 750;
export type HandledShutdownSignal = (typeof DEFAULT_HANDLED_SIGNALS)[number];

export interface GracefulShutdownProcess {
	on(signal: HandledShutdownSignal, listener: () => void): unknown;
	off(signal: HandledShutdownSignal, listener: () => void): unknown;
}

export interface GracefulShutdownController {
	uninstall: () => void;
	requestShutdown: (signal: HandledShutdownSignal) => void;
}

interface GracefulShutdownOptions {
	delayMs: number;
	onShutdown: (signal: HandledShutdownSignal) => Promise<void>;
	onShutdownError?: (error: unknown) => void;
	onSecondSignal?: (signal: HandledShutdownSignal) => void;
	onTimeout?: (delayMs: number) => void;
	process: GracefulShutdownProcess;
	exit: (code: number) => void;
	duplicateSignalWindowMs?: number;
	now?: () => number;
	platform?: NodeJS.Platform;
}

export function getExitCodeForSignal(signal: HandledShutdownSignal | null): number {
	switch (signal) {
		case "SIGHUP":
			return 129;
		case "SIGINT":
			return 130;
		case "SIGQUIT":
			return 131;
		case "SIGTERM":
			return 143;
		case "SIGBREAK":
			return 149;
		default:
			return 0;
	}
}

export function installGracefulShutdownHandlers(options: GracefulShutdownOptions): GracefulShutdownController {
	const processRef = options.process;
	const now = options.now ?? (() => Date.now());
	const duplicateSignalWindowMs = options.duplicateSignalWindowMs ?? DEFAULT_DUPLICATE_SIGNAL_WINDOW_MS;
	const signalListeners = new Map<HandledShutdownSignal, () => void>();
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let shutdownPromise: Promise<void> | null = null;
	let shutdownSignal: HandledShutdownSignal | null = null;
	let shutdownStartedAt = 0;
	let shutdownStartedProgrammatically = false;
	let finalized = false;
	let installed = true;

	const uninstall = () => {
		if (!installed) {
			return;
		}
		installed = false;
		for (const [signal, listener] of signalListeners) {
			processRef.off(signal, listener);
		}
		signalListeners.clear();
	};

	const finalizeExit = (code: number) => {
		if (finalized) {
			return;
		}
		finalized = true;
		uninstall();
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		options.exit(code);
	};

	const startShutdown = (signal: HandledShutdownSignal, requestedProgrammatically = false) => {
		if (shutdownPromise !== null) {
			return;
		}

		shutdownSignal = signal;
		shutdownStartedAt = now();
		shutdownStartedProgrammatically = requestedProgrammatically;
		timeoutId = setTimeout(() => {
			options.onTimeout?.(options.delayMs);
			finalizeExit(1);
		}, options.delayMs);

		shutdownPromise = (async () => {
			try {
				await options.onShutdown(signal);
				finalizeExit(getExitCodeForSignal(signal));
			} catch (error) {
				options.onShutdownError?.(error);
				finalizeExit(1);
			}
		})();
	};

	const handleSignal = (signal: HandledShutdownSignal) => {
		if (shutdownPromise === null) {
			startShutdown(signal);
			return;
		}

		const shouldSuppressRacingSignal = signal === shutdownSignal || shutdownStartedProgrammatically;
		if (shouldSuppressRacingSignal && now() - shutdownStartedAt <= duplicateSignalWindowMs) {
			return;
		}

		options.onSecondSignal?.(signal);
		finalizeExit(getExitCodeForSignal(signal));
	};

	// Programmatic shutdown requests are control-plane intent, not a simulated
	// operating-system signal. Keep them idempotent so a parent disconnect that
	// races a real Ctrl+C cannot be mistaken for a second force-exit request.
	const requestShutdown = (signal: HandledShutdownSignal) => {
		startShutdown(signal, true);
	};

	// Windows emits SIGHUP when its console closes and SIGBREAK for Ctrl+Break.
	// SIGQUIT is the only member of this policy that Windows cannot deliver.
	const platform = options.platform ?? process.platform;
	const signals =
		platform === "win32"
			? DEFAULT_HANDLED_SIGNALS.filter((signal) => signal !== "SIGQUIT")
			: DEFAULT_HANDLED_SIGNALS.filter((signal) => signal !== "SIGBREAK");

	for (const signal of signals) {
		const listener = () => {
			handleSignal(signal);
		};
		signalListeners.set(signal, listener);
		processRef.on(signal, listener);
	}

	return { uninstall, requestShutdown };
}
