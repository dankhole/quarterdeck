import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { type DiagnosticTruncationSummary, normalizeDiagnosticErrorClass } from "../core";

export interface DiagnosticValueLimits {
	maxStringLength: number;
	maxDepth: number;
	maxObjectKeys: number;
	maxArrayEntries: number;
}

export const DEFAULT_DIAGNOSTIC_VALUE_LIMITS: DiagnosticValueLimits = {
	maxStringLength: 2_048,
	maxDepth: 6,
	maxObjectKeys: 50,
	maxArrayEntries: 100,
};

export interface DiagnosticPathAliases {
	stateHome?: string;
	projects?: ReadonlyMap<string, string>;
	worktrees?: ReadonlyMap<string, string>;
	labTemp?: string;
}

export interface SanitizeDiagnosticValueOptions {
	limits?: Partial<DiagnosticValueLimits>;
	pathAliases?: DiagnosticPathAliases;
}

export interface SanitizedDiagnosticValue {
	value: unknown;
	truncation: DiagnosticTruncationSummary | undefined;
}

interface MutableTruncationSummary {
	strings: number;
	arrays: number;
	objects: number;
	depth: number;
	redacted: number;
}

const SENSITIVE_KEY_PATTERN =
	/(?:^|_)(?:authorization|cookie|set_cookie|token|secret|password|passwd|api_key|apikey|private_key|credential|environment|env)(?:$|_)/iu;
const CONTENT_KEY_PATTERN =
	/(?:^|_)(?:prompt|assistant_message|final_message|conversation_summary|last_assistant_message|task_title|description|command|args|argv|stdout|stderr|output|content|diff|patch|terminal_text|snapshot|transcript|request_body|response_body|body|headers)(?:$|_)/iu;
const PATH_KEY_PATTERN =
	/(?:^|_)(?:path|cwd|directory|working_directory|session_launch_path|project_path|repo_path|home)(?:$|_)/iu;
const URL_KEY_PATTERN = /(?:^|_)(?:url|uri|remote|origin)(?:$|_)/iu;
const SECRET_VALUE_PATTERNS = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
	/\b(?:sk|pk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gu,
	/\b[A-Fa-f0-9]{40,}\b/gu,
];
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/giu;
const POSIX_PATH_PATTERN = /(^|[\s("'=])\/(?:[^\s/"'<>:]+\/)+[^\s"'<>:]*/gu;
const WINDOWS_DRIVE_PATH_PATTERN = /\b[A-Za-z]:\/[^"'<>\r\n]*?(?=\s+[A-Za-z_][A-Za-z0-9_.-]*=|$|["'<>\r\n])/gu;
const WINDOWS_UNC_PATH_PATTERN =
	/(^|[\s("'=])\/\/[^/"'<>:\r\n]+\/[^"'<>\r\n]*?(?=\s+[A-Za-z_][A-Za-z0-9_.-]*=|$|["'<>\r\n])/gu;

interface DiagnosticPathReplacement {
	path: string;
	alias: string;
	caseInsensitive: boolean;
}

function createTruncationSummary(): MutableTruncationSummary {
	return { strings: 0, arrays: 0, objects: 0, depth: 0, redacted: 0 };
}

function hasTruncation(summary: MutableTruncationSummary): boolean {
	return Object.values(summary).some((count) => count > 0);
}

function toPublicTruncation(summary: MutableTruncationSummary): DiagnosticTruncationSummary | undefined {
	return hasTruncation(summary) ? { ...summary } : undefined;
}

function normalizeWindowsNamespacePaths(value: string): string {
	return value
		.replaceAll("\\", "/")
		.replace(/\/\/\?\/unc\//giu, "//")
		.replace(/\/\/[?.]\/(?=[A-Za-z]:\/)/gu, "");
}

function isWindowsAbsolutePath(path: string): boolean {
	return /^[A-Za-z]:\//u.test(path) || /^\/\/[^/]+\/[^/]+/u.test(path);
}

function normalizeForComparison(path: string): { path: string; caseInsensitive: boolean } {
	const withoutNamespace = normalizeWindowsNamespacePaths(path);
	const windowsPath = isWindowsAbsolutePath(withoutNamespace);
	const normalized = (windowsPath ? win32.resolve(withoutNamespace) : posix.resolve(withoutNamespace))
		.replaceAll("\\", "/")
		.replace(/\/+$/u, "");
	return {
		path: normalized,
		caseInsensitive: windowsPath,
	};
}

function buildPathReplacements(aliases: DiagnosticPathAliases | undefined): DiagnosticPathReplacement[] {
	const replacements: DiagnosticPathReplacement[] = [];
	const add = (path: string | undefined, alias: string): void => {
		if (!path) return;
		replacements.push({ ...normalizeForComparison(path), alias });
	};
	add(homedir(), "$HOME");
	add(aliases?.stateHome, "$STATE");
	add(aliases?.labTemp, "$LAB_TMP");
	for (const [projectId, path] of aliases?.projects ?? []) {
		add(path, `$PROJECT:${projectId}`);
	}
	for (const [taskId, path] of aliases?.worktrees ?? []) {
		add(path, `$WORKTREE:${taskId}`);
	}
	return replacements.sort((left, right) => right.path.length - left.path.length);
}

function replaceKnownPaths(value: string, replacements: ReadonlyArray<DiagnosticPathReplacement>): string {
	let next = normalizeWindowsNamespacePaths(value);
	for (const replacement of replacements) {
		let searchFrom = 0;
		while (true) {
			let index = -1;
			let matchedLength = replacement.path.length;
			if (replacement.caseInsensitive) {
				const escapedPath = replacement.path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
				const match = new RegExp(escapedPath, "iu").exec(next.slice(searchFrom));
				if (match) {
					index = searchFrom + match.index;
					matchedLength = match[0].length;
				}
			} else {
				index = next.indexOf(replacement.path, searchFrom);
			}
			if (index < 0) break;
			const preceding = next[index - 1];
			const following = next[index + matchedLength];
			const startsAtPathBoundary = preceding === undefined || /[\s("'=:[,{]/u.test(preceding);
			const endsAtPathBoundary = following === undefined || /[/\s)"',:;\]}]/u.test(following);
			if (!startsAtPathBoundary || !endsAtPathBoundary) {
				searchFrom = index + 1;
				continue;
			}
			next = `${next.slice(0, index)}${replacement.alias}${next.slice(index + matchedLength)}`;
			searchFrom = index + replacement.alias.length;
		}
	}
	return next;
}

function redactUrl(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		const port = parsed.port ? `:${parsed.port}` : "";
		return `${parsed.protocol}//$HOST${port}${parsed.pathname ? "/$PATH" : ""}`;
	} catch {
		return "$URL";
	}
}

function redactString(
	value: string,
	key: string | null,
	replacements: ReadonlyArray<DiagnosticPathReplacement>,
	summary: MutableTruncationSummary,
): string {
	if (key && (SENSITIVE_KEY_PATTERN.test(key) || CONTENT_KEY_PATTERN.test(key))) {
		summary.redacted += 1;
		return `[REDACTED:${SENSITIVE_KEY_PATTERN.test(key) ? "sensitive" : "content"}]`;
	}
	if (key && URL_KEY_PATTERN.test(key)) {
		summary.redacted += 1;
		return redactUrl(value);
	}

	let next = replaceKnownPaths(value, replacements);
	for (const pattern of SECRET_VALUE_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(next)) {
			summary.redacted += 1;
			pattern.lastIndex = 0;
			next = next.replace(pattern, "[REDACTED:secret]");
		}
	}
	URL_PATTERN.lastIndex = 0;
	if (URL_PATTERN.test(next)) {
		summary.redacted += 1;
		URL_PATTERN.lastIndex = 0;
		next = next.replace(URL_PATTERN, (match) => redactUrl(match));
	}
	if (key && PATH_KEY_PATTERN.test(key)) {
		const isAliased = next.startsWith("$");
		if (!isAliased && (next.startsWith("/") || /^[A-Za-z]:\//u.test(next))) {
			summary.redacted += 1;
			next = "$PATH";
		}
	}
	WINDOWS_DRIVE_PATH_PATTERN.lastIndex = 0;
	if (WINDOWS_DRIVE_PATH_PATTERN.test(next)) {
		summary.redacted += 1;
		WINDOWS_DRIVE_PATH_PATTERN.lastIndex = 0;
		next = next.replace(WINDOWS_DRIVE_PATH_PATTERN, "$PATH");
	}
	WINDOWS_UNC_PATH_PATTERN.lastIndex = 0;
	if (WINDOWS_UNC_PATH_PATTERN.test(next)) {
		summary.redacted += 1;
		WINDOWS_UNC_PATH_PATTERN.lastIndex = 0;
		next = next.replace(WINDOWS_UNC_PATH_PATTERN, "$1$PATH");
	}
	POSIX_PATH_PATTERN.lastIndex = 0;
	if (POSIX_PATH_PATTERN.test(next)) {
		summary.redacted += 1;
		POSIX_PATH_PATTERN.lastIndex = 0;
		next = next.replace(POSIX_PATH_PATTERN, "$1$PATH");
	}
	return next;
}

function sanitizeError(error: Error): unknown {
	return { errorClass: getDiagnosticErrorClass(error) };
}

function sanitizeValue(
	value: unknown,
	depth: number,
	seen: WeakSet<object>,
	limits: DiagnosticValueLimits,
	replacements: ReadonlyArray<DiagnosticPathReplacement>,
	summary: MutableTruncationSummary,
	key: string | null,
): unknown {
	if (value === null || value === undefined || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : `[${String(value)}]`;
	if (typeof value === "string") {
		const redacted = redactString(value, key, replacements, summary);
		if (redacted.length <= limits.maxStringLength) return redacted;
		summary.strings += 1;
		return `${redacted.slice(0, limits.maxStringLength)}…[truncated]`;
	}
	if (typeof value === "bigint") return `[BigInt:${value.toString().slice(0, 100)}]`;
	if (typeof value === "symbol") return `[Symbol:${value.description?.slice(0, 100) ?? ""}]`;
	if (typeof value === "function") return `[Function:${value.name.slice(0, 100) || "anonymous"}]`;
	if (typeof value !== "object") return `[Unsupported:${typeof value}]`;

	if (depth >= limits.maxDepth) {
		summary.depth += 1;
		return "[MaxDepth]";
	}
	if (seen.has(value)) return "[Circular]";
	seen.add(value);

	if (value instanceof Error) {
		return sanitizeError(value);
	}
	if (value instanceof Date) return Number.isNaN(value.valueOf()) ? "[InvalidDate]" : value.toISOString();
	if (value instanceof URL) return redactUrl(value.toString());
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return `[Binary:${value.byteLength} bytes]`;
	}
	if (value instanceof Map) {
		return sanitizeValue(Array.from(value.entries()), depth + 1, seen, limits, replacements, summary, key);
	}
	if (value instanceof Set) {
		return sanitizeValue(Array.from(value.values()), depth + 1, seen, limits, replacements, summary, key);
	}
	if (Array.isArray(value)) {
		const bounded = value.slice(0, limits.maxArrayEntries);
		if (bounded.length < value.length) summary.arrays += 1;
		return bounded.map((entry) => sanitizeValue(entry, depth + 1, seen, limits, replacements, summary, key));
	}

	const keys = Object.keys(value).sort();
	const boundedKeys = keys.slice(0, limits.maxObjectKeys);
	if (boundedKeys.length < keys.length) summary.objects += 1;
	const output: Record<string, unknown> = {};
	for (const property of boundedKeys) {
		let propertyValue: unknown;
		try {
			propertyValue = Reflect.get(value, property);
		} catch {
			propertyValue = "[GetterThrew]";
		}
		output[property] = sanitizeValue(propertyValue, depth + 1, seen, limits, replacements, summary, property);
	}
	return output;
}

export function sanitizeDiagnosticValue(
	value: unknown,
	options: SanitizeDiagnosticValueOptions = {},
): SanitizedDiagnosticValue {
	const limits: DiagnosticValueLimits = {
		...DEFAULT_DIAGNOSTIC_VALUE_LIMITS,
		...options.limits,
	};
	const summary = createTruncationSummary();
	const sanitized = sanitizeValue(
		value,
		0,
		new WeakSet<object>(),
		limits,
		buildPathReplacements(options.pathAliases),
		summary,
		null,
	);
	return {
		value: sanitized,
		truncation: toPublicTruncation(summary),
	};
}

export function sanitizeDiagnosticText(
	value: string,
	options: SanitizeDiagnosticValueOptions = {},
): { value: string; truncation: DiagnosticTruncationSummary | undefined } {
	const result = sanitizeDiagnosticValue(value, options);
	return {
		value: typeof result.value === "string" ? result.value : "[InvalidText]",
		truncation: result.truncation,
	};
}

/**
 * Reduces an arbitrary thrown value to a stable, content-free classification.
 * Error messages and stacks are deliberately excluded because diagnostics are
 * persisted automatically and may later be shared as a support bundle.
 */
export function getDiagnosticErrorClass(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		const code = normalizeDiagnosticErrorClass(error.code);
		if (code !== "UnknownError") return code;
	}
	if (error instanceof Error) {
		return normalizeDiagnosticErrorClass(error.name);
	}
	return "UnknownError";
}
