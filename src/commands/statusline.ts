import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { buildQuarterdeckCommandParts, createGitProcessEnv, quoteShellArg } from "../core";

// ---------------------------------------------------------------------------
// Input types — matches Claude Code's statusline JSON contract
// ---------------------------------------------------------------------------

const statuslineInputSchema = z.object({
	model: z.object({ display_name: z.string() }),
	session_id: z.string(),
	cwd: z.string(),
	cost: z.object({
		total_cost_usd: z.number(),
		total_duration_ms: z.number(),
		total_lines_added: z.number(),
		total_lines_removed: z.number(),
	}),
	context_window: z.object({
		context_window_size: z.number(),
		used_percentage: z.number().optional(),
		total_input_tokens: z.number().optional(),
		total_output_tokens: z.number().optional(),
		current_usage: z
			.object({
				input_tokens: z.number(),
				cache_creation_input_tokens: z.number().optional(),
				cache_read_input_tokens: z.number().optional(),
			})
			.optional(),
	}),
});

type StatuslineInput = z.infer<typeof statuslineInputSchema>;

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";

const ansi = {
	bold: (s: string) => `\x1b[1m${s}${RESET}`,
	dim: (s: string) => `\x1b[2m${s}${RESET}`,
	cyan: (s: string) => `\x1b[36m${s}${RESET}`,
	brightCyan: (s: string) => `\x1b[96m${s}${RESET}`,
	purple: (s: string) => `\x1b[35m${s}${RESET}`,
	yellow: (s: string) => `\x1b[33m${s}${RESET}`,
	brightYellow: (s: string) => `\x1b[93m${s}${RESET}`,
	green: (s: string) => `\x1b[92m${s}${RESET}`,
	red: (s: string) => `\x1b[31m${s}${RESET}`,
	dimWhite: (s: string) => `\x1b[2;37m${s}${RESET}`,
};

// ---------------------------------------------------------------------------
// Nerd Font glyphs
// ---------------------------------------------------------------------------

const GLYPH = {
	gitBranch: "\uE0A0", //
	modelSonnet: "\uEB99", // nf-cod-hubot
	modelOpus: "\uDB83\uDDD1", // nf-md-brain (U+F09D1)
	modelDefault: "\uF0E7", // nf-fa-bolt
	context: "\uDB80\uDD5B", // nf-md-circle-medium (U+F035B)
	cost: "\uF155", //
	clock: "\uF017", //
	tokens: "\uDB80\uDE19", // nf-md-file-document (U+F0219)
	linesAdded: "\uEADC", // nf-dev-git
	linesRemoved: "\uEADF", // nf-dev-git
	arrowDown: "\u2193", // ↓
	arrowUp: "\u2191", // ↑
	battery100: "\uDB80\uDC79", // nf-md-battery (U+F0079)
	battery75: "\uDB80\uDC78", // nf-md-battery-75
	battery50: "\uDB80\uDC77", // nf-md-battery-50
	battery25: "\uDB80\uDC76", // nf-md-battery-25
	batteryCharging: "\uDB80\uDC84", // nf-md-battery-charging
	folder: "\uF115", // nf-fa-folder_open
};

// ---------------------------------------------------------------------------
// Data formatting
// ---------------------------------------------------------------------------

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}k`;
	}
	return String(tokens);
}

function formatDuration(ms: number): string {
	const secs = Math.floor(ms / 1_000);
	const parts: [number, string][] = [
		[Math.floor(secs / 86_400), "d"],
		[Math.floor((secs % 86_400) / 3_600), "h"],
		[Math.floor((secs % 3_600) / 60), "m"],
		[secs % 60, "s"],
	];
	const formatted = parts
		.filter(([value]) => value > 0)
		.slice(0, 2)
		.map(([value, unit]) => `${value}${unit}`)
		.join("");
	return formatted || "0s";
}

function shortenPath(cwd: string): string {
	if (cwd === homedir()) {
		return "~";
	}
	return basename(cwd);
}

function getModelEmoji(displayName: string): string {
	const lower = displayName.toLowerCase();
	if (lower.includes("sonnet")) {
		return GLYPH.modelSonnet;
	}
	if (lower.includes("opus")) {
		return GLYPH.modelOpus;
	}
	return GLYPH.modelDefault;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

interface GitHeadInfo {
	type: "branch" | "detached";
	label: string;
}

function getGitHead(cwd: string): GitHeadInfo | null {
	try {
		const result = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
			env: createGitProcessEnv(),
		});
		const branch = result.trim();
		if (branch && branch !== "HEAD") {
			return { type: "branch", label: branch };
		}
		// Detached HEAD — resolve the short hash
		const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
			env: createGitProcessEnv(),
		}).trim();
		return hash ? { type: "detached", label: hash } : null;
	} catch {
		return null;
	}
}

function getGitStatus(cwd: string): string | null {
	try {
		const result = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
			env: createGitProcessEnv(),
		});
		if (!result.trim()) {
			return null;
		}
		let hasModified = false;
		let hasStaged = false;
		let hasUntracked = false;
		for (const line of result.split("\n")) {
			if (!line || line.length < 2) {
				continue;
			}
			const index = line[0];
			const working = line[1];
			if (index === "?" && working === "?") {
				hasUntracked = true;
			} else if (index !== " " && index !== "?") {
				hasStaged = true;
			}
			if (working !== " " && working !== "?") {
				hasModified = true;
			}
		}
		const indicators: string[] = [];
		if (hasStaged) indicators.push("+");
		if (hasModified) indicators.push("!");
		if (hasUntracked) indicators.push("?");
		return indicators.length > 0 ? `[${indicators.join("")}]` : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

interface BatteryInfo {
	percent: number;
	charging: boolean;
}

function getBattery(): BatteryInfo | null {
	const os = platform();
	if (os === "darwin") {
		return getMacBattery();
	}
	if (os === "linux") {
		return getLinuxBattery();
	}
	return null;
}

function getMacBattery(): BatteryInfo | null {
	try {
		const result = execFileSync("pmset", ["-g", "batt"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		});
		const percentMatch = result.match(/(\d+)%/);
		if (!percentMatch) {
			return null;
		}
		const percent = Number.parseInt(percentMatch[1], 10);
		const charging = result.includes("AC Power") || result.includes("charging");
		return { percent, charging };
	} catch {
		return null;
	}
}

function getLinuxBattery(): BatteryInfo | null {
	try {
		const capacityStr = readFileSync("/sys/class/power_supply/BAT0/capacity", "utf8").trim();
		const percent = Number.parseInt(capacityStr, 10);
		if (Number.isNaN(percent)) {
			return null;
		}
		let charging = false;
		try {
			const status = readFileSync("/sys/class/power_supply/BAT0/status", "utf8").trim().toLowerCase();
			charging = status === "charging" || status === "full";
		} catch {
			// Status file may not exist on all systems.
		}
		return { percent, charging };
	} catch {
		return null;
	}
}

function formatBattery(info: BatteryInfo): string {
	let icon: string;
	let colorFn: (s: string) => string;

	if (info.charging) {
		icon = GLYPH.batteryCharging;
		colorFn = ansi.green;
	} else if (info.percent > 75) {
		icon = GLYPH.battery100;
		colorFn = ansi.green;
	} else if (info.percent > 50) {
		icon = GLYPH.battery75;
		colorFn = ansi.green;
	} else if (info.percent > 25) {
		icon = GLYPH.battery50;
		colorFn = ansi.yellow;
	} else {
		icon = GLYPH.battery25;
		colorFn = ansi.red;
	}
	return colorFn(`${icon} ${info.percent}%`);
}

// ---------------------------------------------------------------------------
// Line 1: Shell context
// ---------------------------------------------------------------------------

function renderContextLine(cwd: string): string {
	const parts: string[] = [ansi.brightCyan(`${GLYPH.folder} ${shortenPath(cwd)}`)];

	const head = getGitHead(cwd);
	if (head) {
		const status = getGitStatus(cwd);
		if (head.type === "branch") {
			const branchStr = ansi.purple(`${GLYPH.gitBranch} ${head.label}`);
			parts.push(status ? `on ${branchStr} ${ansi.yellow(status)}` : `on ${branchStr}`);
		} else {
			// Detached HEAD — show short hash
			const hashStr = ansi.dimWhite(`${GLYPH.gitBranch} ${head.label}`);
			const baseRef = process.env.QUARTERDECK_BASE_REF;
			const basedOn = baseRef ? ` ${ansi.dim(`based on ${baseRef}`)}` : "";
			parts.push(status ? `${hashStr}${basedOn} ${ansi.yellow(status)}` : `${hashStr}${basedOn}`);
		}
	}

	const battery = getBattery();
	if (battery) {
		parts.push(formatBattery(battery));
	}

	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Line 2: Claude metrics
// ---------------------------------------------------------------------------

function renderMetricsLine(data: StatuslineInput): string {
	const parts: string[] = [];

	// Session ID (last 8 chars)
	const sessionId = data.session_id.length > 8 ? data.session_id.slice(data.session_id.length - 8) : data.session_id;
	parts.push(ansi.dimWhite(sessionId));

	// Model
	const modelEmoji = getModelEmoji(data.model.display_name);
	parts.push(ansi.cyan(`${modelEmoji} ${data.model.display_name}`));

	// Context window with tier coloring
	const pct = data.context_window.used_percentage ?? 0;
	const usage = data.context_window.current_usage;
	const usedTokens = usage
		? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
		: 0;
	const contextStr = `${GLYPH.context} ${formatTokens(usedTokens)}/${formatTokens(data.context_window.context_window_size)} (${Math.round(pct)}%)`;
	if (pct >= 80) {
		parts.push(ansi.red(contextStr));
	} else if (pct >= 50) {
		parts.push(ansi.yellow(contextStr));
	} else {
		parts.push(ansi.green(contextStr));
	}

	// Cost
	parts.push(ansi.yellow(`${GLYPH.cost} ${data.cost.total_cost_usd.toFixed(2)}`));

	// Duration
	parts.push(ansi.brightYellow(`${GLYPH.clock} ${formatDuration(data.cost.total_duration_ms)}`));

	// Tokens
	const totalIn = data.context_window.total_input_tokens ?? 0;
	const totalOut = data.context_window.total_output_tokens ?? 0;
	parts.push(
		ansi.dimWhite(
			`${GLYPH.tokens} ${formatTokens(totalIn)}${GLYPH.arrowDown} ${formatTokens(totalOut)}${GLYPH.arrowUp}`,
		),
	);

	// Lines changed
	parts.push(ansi.green(`${GLYPH.linesAdded} +${data.cost.total_lines_added}`));
	parts.push(ansi.red(`${GLYPH.linesRemoved} -${data.cost.total_lines_removed}`));

	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

function renderStatusline(data: StatuslineInput): string {
	const line1 = renderContextLine(data.cwd);
	const line2 = renderMetricsLine(data);
	return `${line1}\n${line2}`;
}

// ---------------------------------------------------------------------------
// stdin reader
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) {
		return "";
	}
	const chunks: string[] = [];
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		chunks.push(chunk as string);
	}
	return chunks.join("");
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

async function runStatusline(): Promise<void> {
	const raw = await readStdin();
	if (!raw.trim()) {
		process.stderr.write("quarterdeck statusline: no input received on stdin\n");
		process.exitCode = 1;
		return;
	}

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		process.stderr.write("quarterdeck statusline: invalid JSON input\n");
		process.exitCode = 1;
		return;
	}

	const parsed = statuslineInputSchema.safeParse(json);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		process.stderr.write(`quarterdeck statusline: invalid input — ${issues}\n`);
		process.exitCode = 1;
		return;
	}

	try {
		process.stdout.write(renderStatusline(parsed.data));
	} catch (err) {
		process.stderr.write(`quarterdeck statusline: render failed — ${err instanceof Error ? err.message : err}\n`);
		process.exitCode = 1;
	}
}

export function buildStatuslineCommand(): string {
	return buildQuarterdeckCommandParts(["statusline"]).map(quoteShellArg).join(" ");
}

export function registerStatuslineCommand(program: Command): void {
	program
		.command("statusline")
		.description("Render Claude Code statusline (reads JSON from stdin).")
		.action(async () => {
			await runStatusline();
		});
}
