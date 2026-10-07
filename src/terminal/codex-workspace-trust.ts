import type { RuntimeAgentId } from "../core";
import type { TerminalScreenSnapshot } from "./terminal-state-mirror";

const CODEX_WORKSPACE_TRUST_TOKENS = ["do", "you", "trust", "the", "contents", "of", "this", "directory"];

const MODERN_CODEX_TRUST_DISCLOSURE =
	"Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. " +
	"Folder settings can run code automatically, even without a model request. " +
	"Continue only if you trust these files. Your trust decision will be saved.";
const MODERN_CODEX_GIT_ROOT_WARNING =
	"Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";

function hasCanonicalTrustPrelude(rows: string[]): boolean {
	const groups = rows
		.join("\n")
		.trim()
		.split(/\n\s*\n/gu)
		.map((group) => group.split("\n").map((row) => row.trim()));
	// Paths may wrap or contain unusual names. This classifies display groups;
	// the exact active launch, never the displayed path, owns trust admission.
	const isDisplayedPath = (group: string[]) => /^(?:\/|[a-z]:[\\/])/iu.test(group[0] ?? "");
	const firstGroup = groups[0];
	if (!firstGroup) return false;
	if (groups.length === 1 && isDisplayedPath(firstGroup)) return true;
	if (groups.length !== 1 && groups.length !== 2) return false;
	const warningIndex = groups.length - 1;
	if (warningIndex === 1 && !isDisplayedPath(firstGroup)) return false;
	// The warning and repository path are adjacent in the native dialog.
	const warningAndPath = groups[warningIndex];
	if (!warningAndPath) return false;
	for (let end = 1; end < warningAndPath.length; end += 1) {
		if (warningAndPath.slice(0, end).join(" ") === MODERN_CODEX_GIT_ROOT_WARNING)
			return isDisplayedPath(warningAndPath.slice(end));
	}
	return false;
}

export interface CodexWorkspaceTrustScreen {
	visible: boolean;
	selection: "confirm" | "cancel" | null;
}

/** Recognizes the complete unrestricted Codex 0.159 onboarding viewport, never transcript fragments. */
export function readCodexWorkspaceTrustScreen(screen: TerminalScreenSnapshot): CodexWorkspaceTrustScreen {
	const lines = screen.lines.map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean);
	if (lines[0] !== "Folder access") return { visible: false, selection: null };
	const incomplete: CodexWorkspaceTrustScreen = { visible: true, selection: null };
	const trustIndex = lines.findIndex((line) => /^(?:›\s*)?1\. Trust and continue$/u.test(line));
	if (trustIndex < 2) return incomplete;
	if (!/^enter continue(?: and create sandbox)? · esc quit$/u.test(lines.slice(trustIndex + 2).join(" ")))
		return incomplete;
	const trust = lines[trustIndex];
	const quit = lines[trustIndex + 1];
	if (quit === undefined || !/^(?:›\s*)?2\. Quit$/u.test(quit)) return incomplete;
	const disclosureIndex = lines.findIndex((line) => line.startsWith("Trust this folder?"));
	if (
		disclosureIndex < 1 ||
		disclosureIndex >= trustIndex ||
		lines.slice(disclosureIndex, trustIndex).join(" ") !== MODERN_CODEX_TRUST_DISCLOSURE
	)
		return incomplete;
	const originalDisclosureIndex = screen.lines.findIndex((line) => line.trim().startsWith("Trust this folder?"));
	const originalHeaderIndex = screen.lines.findIndex((line) => line.trim() === "Folder access");
	if (!hasCanonicalTrustPrelude(screen.lines.slice(originalHeaderIndex + 1, originalDisclosureIndex)))
		return incomplete;
	if (trust === "› 1. Trust and continue" && quit === "2. Quit") return { visible: true, selection: "confirm" };
	if (trust === "1. Trust and continue" && quit === "› 2. Quit") return { visible: true, selection: "cancel" };
	return incomplete;
}

export interface CodexWorkspaceTrustDriverState {
	outputRevision: number;
	pendingRevision: number | null;
	screen: TerminalScreenSnapshot | null;
	confirmed: boolean;
	manualInput: boolean;
}

export function createCodexWorkspaceTrustDriverState(): CodexWorkspaceTrustDriverState {
	return { outputRevision: 0, pendingRevision: null, screen: null, confirmed: false, manualInput: false };
}

function normalizeTerminalText(input: string): string {
	return input.toLowerCase().replace(/\s+/gu, " ");
}

function stripAnsiAndControl(input: string): string {
	let output = "";
	let mode: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
	for (const char of input) {
		if (mode === "text") {
			if (char === "\u001b") {
				mode = "escape";
				continue;
			}
			const code = char.charCodeAt(0);
			if ((code >= 32 && code !== 127) || char === "\n" || char === "\r" || char === "\t") {
				output += char;
			}
			continue;
		}
		if (mode === "escape") {
			if (char === "[") {
				mode = "csi";
				continue;
			}
			if (char === "]") {
				mode = "osc";
				continue;
			}
			mode = "text";
			continue;
		}
		if (mode === "csi") {
			const code = char.charCodeAt(0);
			if (code >= 64 && code <= 126) {
				mode = "text";
			}
			continue;
		}
		if (mode === "osc") {
			if (char === "\u0007") {
				mode = "text";
			} else if (char === "\u001b") {
				mode = "osc_escape";
			}
			continue;
		}
		if (mode === "osc_escape") {
			mode = char === "\\" ? "text" : "osc";
		}
	}
	return output;
}

export function hasCodexWorkspaceTrustPrompt(text: string): boolean {
	const rawNormalized = normalizeTerminalText(text);
	if (hasOrderedTokens(rawNormalized, CODEX_WORKSPACE_TRUST_TOKENS)) {
		return true;
	}
	const strippedNormalized = normalizeTerminalText(stripAnsiAndControl(text));
	return hasOrderedTokens(strippedNormalized, CODEX_WORKSPACE_TRUST_TOKENS);
}

function hasOrderedTokens(input: string, tokens: readonly string[]): boolean {
	let index = 0;
	for (const token of tokens) {
		const found = input.indexOf(token, index);
		if (found === -1) {
			return false;
		}
		index = found + token.length;
	}
	return true;
}

export function shouldAutoConfirmCodexWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	void cwd;
	return agentId === "codex";
}
