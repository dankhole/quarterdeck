/**
 * Captures uncaught errors and unhandled promise rejections into the debug log panel.
 * Also intercepts console.error/console.warn so library errors surface in the panel.
 *
 * Call `installGlobalErrorCapture()` once at app startup.
 * Call `setGlobalErrorCallback()` to wire/unwire the debug log callback.
 *
 * ## Cross-module coupling with client-logger
 *
 * This module and `client-logger.ts` share the `isEmitting` flag to prevent
 * duplicate log entries. When client-logger calls `console.error(...)`, the
 * patched console method here would re-capture that same message. The flag
 * suppresses capture during client-logger's `emit()` call.
 *
 * If you add another module that calls `console.error` and also pushes entries
 * to the debug panel via `addClientLogEntry`, you'll need the same
 * `setIsEmitting(true/false)` wrapper around the console call to avoid dupes.
 *
 * ## Console intercept noise
 *
 * When the callback is active, EVERY `console.warn` and `console.error` from
 * any source (React dev warnings, xterm.js, third-party libraries) appears in
 * the debug panel tagged as "console". This can drown out app-level entries.
 * The debug panel exposes a "Show console" toggle (off by default) so users
 * opt into this noise rather than being overwhelmed by it.
 */

type ErrorCallback = (level: "error" | "warn", tag: string, message: string, data?: unknown) => void;

let callback: ErrorCallback | null = null;
let installed = false;
/** Re-entry guard to prevent feedback loops with client-logger (which calls console[level]). */
let isEmitting = false;

export function setGlobalErrorCallback(cb: ErrorCallback | null): void {
	callback = cb;
}

/**
 * Temporarily suppress console capture so that console.warn/error calls
 * originating from client-logger.emit() don't produce duplicate entries.
 */
export function setIsEmitting(value: boolean): void {
	isEmitting = value;
}

function notify(level: "error" | "warn", tag: string, message: string, data?: unknown): void {
	if (isEmitting) return;
	isEmitting = true;
	try {
		callback?.(level, tag, message, data);
	} finally {
		isEmitting = false;
	}
}

function formatErrorMessage(value: unknown): string {
	if (value instanceof Error) {
		return value.stack ?? `${value.name}: ${value.message}`;
	}
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function installGlobalErrorCapture(): () => void {
	if (installed) return () => {};
	installed = true;

	// --- Uncaught errors ---
	const onError = (event: ErrorEvent): void => {
		notify(
			"error",
			"uncaught",
			event.message || "Unknown error",
			event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
		);
	};
	window.addEventListener("error", onError);

	// --- Unhandled promise rejections ---
	const onRejection = (event: PromiseRejectionEvent): void => {
		notify("error", "unhandled-rejection", formatErrorMessage(event.reason));
	};
	window.addEventListener("unhandledrejection", onRejection);

	// --- Intercept console.error and console.warn ---
	const originalConsoleError = console.error;
	const originalConsoleWarn = console.warn;

	console.error = (...args: unknown[]) => {
		originalConsoleError.apply(console, args);
		if (!callback || isEmitting) return;
		const message = args.map((a) => (typeof a === "string" ? a : formatErrorMessage(a))).join(" ");
		notify("error", "console", message);
	};

	console.warn = (...args: unknown[]) => {
		originalConsoleWarn.apply(console, args);
		if (!callback || isEmitting) return;
		const message = args.map((a) => (typeof a === "string" ? a : formatErrorMessage(a))).join(" ");
		notify("warn", "console", message);
	};

	return () => {
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onRejection);
		console.error = originalConsoleError;
		console.warn = originalConsoleWarn;
		installed = false;
	};
}
