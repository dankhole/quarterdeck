/**
 * Centralized toast helpers. ALL user-facing error messages — especially those
 * originating from git operations (commit, checkout, merge, branch create, discard)
 * — MUST go through {@link showAppToast} or {@link notifyError}. These functions
 * automatically truncate long error output (e.g. pre-commit hook stderr, merge
 * conflict dumps) so the toast remains readable.
 *
 * Do NOT import `toast` from "sonner" directly in feature code. If you need a
 * toast, use `showAppToast` or `notifyError` from this module.
 */
import { toast } from "sonner";

import { createClientLogger } from "@/utils/client-logger";

const log = createClientLogger("toast");

const TOAST_TRUNCATE_THRESHOLD = 150;

/**
 * Prepare an error message for toast display.
 * Truncates to the first non-empty line if the message is multi-line or too
 * long (safety net for e.g. multi-page pre-commit hook output).
 */
export function sanitizeErrorForToast(message: string): string {
	if (message.length <= TOAST_TRUNCATE_THRESHOLD && !message.includes("\n")) {
		return message;
	}
	const firstLine = message
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!firstLine) return message;
	if (firstLine.length <= TOAST_TRUNCATE_THRESHOLD) return firstLine;
	return `${firstLine.slice(0, TOAST_TRUNCATE_THRESHOLD - 1)}\u2026`;
}

interface AppToastProps {
	intent?: "danger" | "warning" | "success" | "primary" | "none";
	icon?: string;
	message: string;
	timeout?: number;
	action?: { label: string; onClick: () => void };
}

interface NotifyErrorOptions {
	key?: string;
	timeout?: number;
}

export function showAppToast(props: AppToastProps, key?: string): void {
	const displayMessage = props.intent === "danger" ? sanitizeErrorForToast(props.message) : props.message;
	const options: Parameters<typeof toast>[1] = {
		id: key,
		duration: props.timeout ?? 5000,
		action: props.action,
	};
	if (props.intent === "danger") {
		toast.error(displayMessage, options);
	} else if (props.intent === "warning") {
		toast.warning(props.message, options);
	} else if (props.intent === "success") {
		toast.success(props.message, options);
	} else {
		toast(props.message, options);
	}
}

export function notifyError(message: string | null | undefined, options?: NotifyErrorOptions): void {
	const normalized = message?.trim();
	if (!normalized) {
		return;
	}
	log.error(normalized);
	showAppToast(
		{
			intent: "danger",
			icon: "warning-sign",
			message: normalized,
			timeout: options?.timeout ?? 7000,
		},
		options?.key ?? `error:${sanitizeErrorForToast(normalized)}`,
	);
}
