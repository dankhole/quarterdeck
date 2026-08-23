import { normalizeDiagnosticErrorClass } from "@runtime-contract";

const MAX_STRING_LENGTH = 2_048;
const MAX_DEPTH = 6;
const MAX_OBJECT_KEYS = 50;
const MAX_ARRAY_ITEMS = 100;

const SENSITIVE_KEY =
	/(?:authorization|cookie|credential|password|secret|token|api[_-]?key|private[_-]?key|prompt|transcript|terminal|content|body|diff|environment|env|args|command)/iu;
const TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/giu;
const URL_QUERY_PATTERN = /([?&](?:token|key|secret|password|auth)=[^&#\s]*)/giu;
const FILE_URL_PATTERN = /file:\/\/[^\s)]+/giu;
const NETWORK_URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/giu;
const POSIX_PATH_PATTERN = /(^|[\s("'=])\/(?:[^\s/"'<>:]+\/)+[^\s"'<>:]*/gu;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\s\\"'<>:]+\\)+[^\s"'<>:]*/gu;

function sanitizeString(value: string): string {
	const redacted = value
		.replace(TOKEN_PATTERN, "[REDACTED_TOKEN]")
		.replace(URL_QUERY_PATTERN, "[REDACTED_QUERY]")
		.replace(FILE_URL_PATTERN, "[REDACTED_FILE_URL]")
		.replace(NETWORK_URL_PATTERN, "$URL")
		.replace(POSIX_PATH_PATTERN, "$1$PATH")
		.replace(WINDOWS_PATH_PATTERN, "$PATH");
	return redacted.length <= MAX_STRING_LENGTH ? redacted : `${redacted.slice(0, MAX_STRING_LENGTH)}…`;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return sanitizeString(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return null;
	if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;
	if (depth >= MAX_DEPTH) return "[DEPTH_LIMIT]";
	if (value instanceof Error) {
		return { errorClass: normalizeDiagnosticErrorClass(value.name) };
	}
	if (typeof value !== "object") return sanitizeString(String(value));
	if (seen.has(value)) return "[CIRCULAR]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, depth + 1, seen));
		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
			result[sanitizeString(key).slice(0, 128)] = SENSITIVE_KEY.test(key)
				? "[REDACTED]"
				: walk(child, depth + 1, seen);
			SENSITIVE_KEY.lastIndex = 0;
		}
		return result;
	} catch {
		return "[UNREADABLE_VALUE]";
	} finally {
		seen.delete(value);
	}
}

export function sanitizeBrowserDiagnosticValue(value: unknown): unknown {
	return walk(value, 0, new WeakSet());
}

export function sanitizeBrowserDiagnosticText(value: string): string {
	return sanitizeString(value);
}
