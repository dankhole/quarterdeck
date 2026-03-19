export interface ParsedToolMessageContent {
	toolName: string;
	input: string | null;
	output: string | null;
	error: string | null;
	durationMs: number | null;
}

/**
 * Formats the first element of a string array, appending "(+N more)" if there are extras.
 */
function formatArraySummary(arr: unknown[]): string | null {
	if (arr.length === 0) return null;
	const first = String(arr[0]).split("\n")[0]?.trim();
	if (!first) return null;
	return arr.length > 1 ? `${first} (+${arr.length - 1} more)` : first;
}

function formatArrayList(arr: unknown[]): string | null {
	const items = arr
		.map((value) => String(value).split("\n")[0]?.trim())
		.filter((value): value is string => Boolean(value));

	if (items.length === 0) return null;
	return items.join(", ");
}

function normalizeToolName(toolName: string): string {
	return toolName.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Extracts a short, human-readable summary from the tool's input parameters.
 * Uses tool-specific logic for known Cline SDK tools, then falls back to generic extraction.
 */
export function getToolSummary(toolName: string, input: string | null): string | null {
	if (!input) return null;

	try {
		const parsed: unknown = JSON.parse(input);
		const normalizedToolName = normalizeToolName(toolName);

		if (normalizedToolName === "readfiles") {
			if (typeof parsed === "string") {
				return parsed.trim() || null;
			}
			if (Array.isArray(parsed)) {
				return formatArrayList(parsed);
			}
		}

		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;

			// Cline SDK built-in tools have specific parameter shapes
			switch (normalizedToolName) {
				case "runcommands": {
					if (Array.isArray(record.commands)) return formatArraySummary(record.commands);
					break;
				}
				case "readfiles": {
					if (Array.isArray(record.file_paths)) return formatArrayList(record.file_paths);
					break;
				}
				case "searchcodebase": {
					if (Array.isArray(record.queries)) return formatArraySummary(record.queries);
					break;
				}
				case "editor": {
					const path = record.path;
					const cmd = record.command;
					if (typeof path === "string") {
						return typeof cmd === "string" ? `${cmd} ${path}` : path;
					}
					break;
				}
				case "fetchwebcontent": {
					if (Array.isArray(record.requests) && record.requests.length > 0) {
						const first = record.requests[0];
						if (typeof first === "object" && first !== null && "url" in first) {
							const url = String((first as Record<string, unknown>).url);
							return record.requests.length > 1 ? `${url} (+${record.requests.length - 1} more)` : url;
						}
					}
					break;
				}
				case "skills": {
					if (typeof record.skill === "string") return record.skill;
					break;
				}
				case "askquestion": {
					if (typeof record.question === "string") return record.question.split("\n")[0] ?? null;
					break;
				}
			}

			// Generic fallback for MCP tools and others: try common scalar keys, then arrays
			for (const value of Object.values(record)) {
				if (typeof value === "string" && value.trim().length > 0) {
					return value.trim().split("\n")[0]?.slice(0, 120) ?? null;
				}
				if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
					return formatArraySummary(value);
				}
			}
		}
	} catch {
		// Not JSON, fall through
	}

	const firstLine = input.split("\n").find((line) => line.trim().length > 0);
	return firstLine ? firstLine.trim().slice(0, 120) : null;
}

// -- Tool output parsing (ToolOperationResult format) --

export interface ToolOutputResult {
	query: string;
	content: string;
	error: string | null;
	success: boolean;
}

export interface ParsedToolOutput {
	results: ToolOutputResult[];
}

function isToolOperationResult(
	value: unknown,
): value is { query: string; result: string; success: boolean; error?: string } {
	if (typeof value !== "object" || value === null) return false;
	if (!("success" in value) || !("result" in value)) return false;
	const obj = value as Record<string, unknown>;
	return typeof obj.result === "string" && typeof obj.success === "boolean";
}

function toToolOutputResult(item: {
	query: string;
	result: string;
	success: boolean;
	error?: string;
}): ToolOutputResult {
	return {
		query: String(item.query ?? ""),
		content: item.result,
		error: typeof item.error === "string" ? item.error : null,
		success: item.success,
	};
}

/**
 * Parses raw tool output JSON into structured results.
 * Handles both single ToolOperationResult and ToolOperationResult[] (batch tools).
 */
export function parseToolOutput(output: string): ParsedToolOutput | null {
	try {
		const parsed: unknown = JSON.parse(output);

		if (Array.isArray(parsed) && parsed.length > 0 && isToolOperationResult(parsed[0])) {
			return { results: parsed.filter(isToolOperationResult).map(toToolOutputResult) };
		}

		if (isToolOperationResult(parsed)) {
			return { results: [toToolOutputResult(parsed)] };
		}
	} catch {
		// Not JSON
	}

	return null;
}


function normalizeSectionValue(lines: string[]): string | null {
	const value = lines.join("\n").trim();
	return value.length > 0 ? value : null;
}

export function parseToolMessageContent(content: string): ParsedToolMessageContent {
	const lines = content.split("\n");
	let toolName = "unknown";
	let durationMs: number | null = null;

	const sections = {
		input: [] as string[],
		output: [] as string[],
		error: [] as string[],
	};

	type ActiveSection = keyof typeof sections | null;
	let activeSection: ActiveSection = null;

	for (const line of lines) {
		if (line.startsWith("Tool:")) {
			toolName = line.slice("Tool:".length).trim() || "unknown";
			activeSection = null;
			continue;
		}
		if (line === "Input:") {
			activeSection = "input";
			continue;
		}
		if (line === "Output:") {
			activeSection = "output";
			continue;
		}
		if (line === "Error:") {
			activeSection = "error";
			continue;
		}
		if (line.startsWith("Duration:")) {
			activeSection = null;
			const durationMatch = /Duration:\s*(\d+)ms/i.exec(line);
			if (durationMatch?.[1]) {
				durationMs = Number.parseInt(durationMatch[1], 10);
			}
			continue;
		}
		if (activeSection) {
			sections[activeSection].push(line);
		}
	}

	return {
		toolName,
		input: normalizeSectionValue(sections.input),
		output: normalizeSectionValue(sections.output),
		error: normalizeSectionValue(sections.error),
		durationMs,
	};
}
