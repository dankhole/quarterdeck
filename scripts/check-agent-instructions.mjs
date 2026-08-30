import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const agentsPath = path.join(repoRoot, "AGENTS.md");
const claudePath = path.join(repoRoot, "CLAUDE.md");
const testingPath = path.join(repoRoot, "docs", "testing.md");
const structuredExecutionPath = path.join(repoRoot, "docs", "conventions", "structured-execution.md");

const agents = readFileSync(agentsPath, "utf8");
const claude = readFileSync(claudePath, "utf8");
const claudeLines = claude.trim().split(/\r?\n/);
const agentsMaxBytes = 16 * 1024;
const agentsBytes = Buffer.byteLength(agents, "utf8");

const errors = [];

if (!/AGENTS\.md.*canonical/i.test(agents)) {
	errors.push("AGENTS.md must document that it is the canonical shared agent-instructions file.");
}

if (agentsBytes > agentsMaxBytes) {
	errors.push(
		`AGENTS.md should remain a compact routing contract; expected ${agentsMaxBytes} bytes or fewer, found ${agentsBytes}.`,
	);
}

if (!agents.includes("docs/testing.md")) {
	errors.push("AGENTS.md must route validation selection to docs/testing.md.");
}

if (!existsSync(testingPath)) {
	errors.push("docs/testing.md must exist as the canonical validation-selection guide.");
}

if (!agents.includes("docs/conventions/structured-execution.md") || !existsSync(structuredExecutionPath)) {
	errors.push("AGENTS.md must route structured execution to its stable convention document.");
}

if (!claude.startsWith("# Claude Code Compatibility Shim")) {
	errors.push("CLAUDE.md must start with the Claude compatibility shim heading.");
}

if (!claude.includes("@AGENTS.md")) {
	errors.push("CLAUDE.md must import AGENTS.md.");
}

if (!claude.includes("@README.md") || !claude.includes("@DEVELOPMENT.md") || !claude.includes("@docs/README.md")) {
	errors.push("CLAUDE.md must point humans to README.md, DEVELOPMENT.md, and docs/README.md.");
}

if (!/do not duplicate/i.test(claude)) {
	errors.push("CLAUDE.md must explicitly forbid duplicated shared instructions and project-overview content.");
}

if (/```/.test(claude)) {
	errors.push("CLAUDE.md should stay minimal and must not contain fenced code blocks.");
}

if (claudeLines.length > 25) {
	errors.push(`CLAUDE.md should stay tiny; expected 25 lines or fewer, found ${claudeLines.length}.`);
}

if (errors.length > 0) {
	console.error("Agent-instruction bridge check failed:\n");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}

console.log("Agent-instruction bridge check passed.");
