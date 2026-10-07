import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeAgentId } from "../../../src/core";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "../../../src/terminal";
import { readCodexWorkspaceTrustScreen } from "../../../src/terminal/codex-workspace-trust";
import { type TerminalScreenSnapshot, TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";
import {
	MODERN_CODEX_TRUST_DISCLOSURE,
	MODERN_CODEX_TRUST_RENDER_ANSI,
	renderModernCodexTrustANSI,
} from "./codex-workspace-trust-fixtures";

const mirrors: TerminalStateMirror[] = [];
afterEach(() => {
	for (const mirror of mirrors.splice(0)) mirror.dispose();
});
function createMirror(cols = 80): TerminalStateMirror {
	const mirror = new TerminalStateMirror(cols, 40);
	mirrors.push(mirror);
	return mirror;
}
function apply(mirror: TerminalStateMirror, output: string | Buffer): Promise<TerminalScreenSnapshot> {
	return new Promise((resolve) =>
		mirror.applyOutput(typeof output === "string" ? Buffer.from(output) : output, resolve),
	);
}
async function render(output = MODERN_CODEX_TRUST_RENDER_ANSI, cols = 80): Promise<TerminalScreenSnapshot> {
	return apply(createMirror(cols), output);
}

describe("hasCodexWorkspaceTrustPrompt", () => {
	it("returns true for plain 'Do you trust the contents of this directory?' text", () => {
		const prompt =
			"Do you trust the contents of this directory? Working with untrusted contents comes with higher risk.";
		expect(hasCodexWorkspaceTrustPrompt(prompt)).toBe(true);
	});

	it("returns true with ANSI codes interspersed", () => {
		const ansiPrompt =
			"Do you trust the \u001b[31mcontents\u001b[0m of this directory? Working with untrusted contents.";
		expect(hasCodexWorkspaceTrustPrompt(ansiPrompt)).toBe(true);
	});

	it("returns true for realistic multi-line Codex trust prompt", () => {
		const codexPrompt = `
You are in /Users/saoud/.quarterdeck/worktrees/6df3a/mcp-swift-sdk

Do you trust the contents of this directory? Working with untrusted
contents comes with higher risk of prompt injection.

› 1. Yes, continue
  2. No, quit

Press enter to continue`;
		expect(hasCodexWorkspaceTrustPrompt(codexPrompt)).toBe(true);
	});

	it("returns true with extra whitespace and newlines between tokens", () => {
		const spaceyPrompt = "Do  you\n  trust   the\n\tcontents  of\n  this   directory";
		expect(hasCodexWorkspaceTrustPrompt(spaceyPrompt)).toBe(true);
	});

	it("returns false for 'Do you trust this directory?' (missing 'contents of')", () => {
		expect(hasCodexWorkspaceTrustPrompt("Do you trust this directory?")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasCodexWorkspaceTrustPrompt("")).toBe(false);
	});

	it("returns false for unrelated text", () => {
		expect(hasCodexWorkspaceTrustPrompt("Running tests in /home/user/project")).toBe(false);
	});
});

describe("shouldAutoConfirmCodexWorkspaceTrust", () => {
	it("returns true for codex agent with any cwd", () => {
		expect(shouldAutoConfirmCodexWorkspaceTrust("codex", "/any/path")).toBe(true);
		expect(shouldAutoConfirmCodexWorkspaceTrust("codex", "/home/user/project")).toBe(true);
	});

	it("returns false for claude agent", () => {
		expect(shouldAutoConfirmCodexWorkspaceTrust("claude", "/any/path")).toBe(false);
	});

	it("returns false for other agent ids", () => {
		expect(shouldAutoConfirmCodexWorkspaceTrust("other" as RuntimeAgentId, "/any/path")).toBe(false);
	});
});

describe("readCodexWorkspaceTrustScreen", () => {
	it.each([80, 40])("recognizes the complete native trust screen rendered at %i columns", async (cols) => {
		const screen = await render(renderModernCodexTrustANSI({ cols }), cols);
		expect(screen.lines.filter((line) => line.includes("Trust this folder?")).length).toBe(1);
		expect(readCodexWorkspaceTrustScreen(screen)).toEqual({ visible: true, selection: "confirm" });
	});
	it.each([80, 40])("accepts the exact Git-root warning and wrapped synthetic path at %i columns", async (cols) => {
		const screen = await render(
			renderModernCodexTrustANSI({
				cols,
				gitRoot: true,
				path: "/synthetic/quarterdeck/very-long-fixture-worktree/subdirectory",
			}),
			cols,
		);
		expect(readCodexWorkspaceTrustScreen(screen)).toEqual({ visible: true, selection: "confirm" });
	});
	it.each([80, 40])("recognizes the complete Windows create-sandbox footer at %i columns", async (cols) => {
		const screen = await render(renderModernCodexTrustANSI({ cols, windows: true }), cols);
		expect(readCodexWorkspaceTrustScreen(screen)).toEqual({ visible: true, selection: "confirm" });
	});
	it("reports cancel only for the complete decline-selected screen", async () => {
		expect(readCodexWorkspaceTrustScreen(await render(renderModernCodexTrustANSI({ selection: "cancel" })))).toEqual({
			visible: true,
			selection: "cancel",
		});
		const partial = await render(
			renderModernCodexTrustANSI({ selection: "cancel" }).replace("enter continue · esc quit", "enter"),
		);
		expect(readCodexWorkspaceTrustScreen(partial)).toEqual({ visible: true, selection: null });
	});
	it("requires the whole viewport to settle after split ANSI and UTF-8 chunks", async () => {
		const mirror = createMirror(40);
		const output = Buffer.from(renderModernCodexTrustANSI({ cols: 40 }));
		const split = output.indexOf(Buffer.from("›")) + 1;
		const beforeSelection = await apply(mirror, output.subarray(0, split));
		expect(readCodexWorkspaceTrustScreen(beforeSelection)).toEqual({ visible: true, selection: null });
		const beforeFooter = await apply(mirror, output.subarray(split, output.length - 20));
		expect(readCodexWorkspaceTrustScreen(beforeFooter)).toEqual({ visible: true, selection: null });
		const complete = await apply(mirror, output.subarray(output.length - 20));
		expect(readCodexWorkspaceTrustScreen(complete)).toEqual({ visible: true, selection: "confirm" });
	});
	it("exposes an incomplete current trust header without accepting its choice", async () => {
		const screen = await render(
			"\u001b[2J\u001b[H\r\n  Folder access\r\n\r\n  /synthetic/fixture\r\n  Trust this folder?",
		);
		expect(readCodexWorkspaceTrustScreen(screen)).toEqual({ visible: true, selection: null });
	});
	it.each([
		["missing disclosure", (output: string) => output.replace("Trust this folder?", "")],
		["altered disclosure", (output: string) => output.replace("will be saved.", "will not be saved.")],
		["clipped footer", (output: string) => output.replace("enter continue · esc quit", "enter continue · esc qui")],
		["unselected choices", (output: string) => output.replace("› 1. Trust and continue", "  1. Trust and continue")],
		["two selected choices", (output: string) => output.replace("  2. Quit", "› 2. Quit")],
		[
			"unsupported selected pointer",
			(output: string) => output.replace("› 1. Trust and continue", "> 1. Trust and continue"),
		],
		[
			"restricted option",
			(output: string) => output.replace("1. Trust and continue", "1. Continue with limited access"),
		],
		["existing-task option", (output: string) => output.replace("1. Trust and continue", "1. Open existing task")],
		["agent-command-center option", (output: string) => output.replace("2. Quit", "2. Back to Agent Command Center")],
	] as const)("keeps the visible header inert with %s", async (_name, mutate) => {
		const output = mutate(MODERN_CODEX_TRUST_RENDER_ANSI);
		expect(output).not.toBe(MODERN_CODEX_TRUST_RENDER_ANSI);
		expect(readCodexWorkspaceTrustScreen(await render(output))).toEqual({
			visible: true,
			selection: null,
		});
	});
	it("rejects a canonical dialog with any rendered content after its footer", async () => {
		const screen = await render(`${MODERN_CODEX_TRUST_RENDER_ANSI}\r\n\r\n› Ask Codex to edit a file`);
		expect(readCodexWorkspaceTrustScreen(screen)).toEqual({ visible: true, selection: null });
	});
	it.each([
		"Transcript: Folder access",
		"> Folder access",
		'const title = "Folder access";',
		"Would you like to run the following command?",
	])("ignores quoted or embedded trust text below %s", async (title) => {
		const output = MODERN_CODEX_TRUST_RENDER_ANSI.replace("Folder access", title);
		expect(readCodexWorkspaceTrustScreen(await render(output))).toEqual({ visible: false, selection: null });
	});
	it("does not treat a trust dialog quoted inside a newer transcript as current", async () => {
		const screen = await render(MODERN_CODEX_TRUST_RENDER_ANSI);
		const transcript = { ...screen, lines: ["• Reviewing a trust-screen example", ...screen.lines.slice(0, -1)] };
		expect(readCodexWorkspaceTrustScreen(transcript)).toEqual({ visible: false, selection: null });
	});
	it("rejects permission or transcript content inserted before the canonical disclosure", async () => {
		const screen = await render(
			MODERN_CODEX_TRUST_RENDER_ANSI.replace("Trust this folder?", "Choose restricted access\r\nTrust this folder?"),
		);
		expect(readCodexWorkspaceTrustScreen(screen)).toEqual({ visible: true, selection: null });
	});
	it("recognizes only the exact current Folder access heading", async () => {
		expect(readCodexWorkspaceTrustScreen(await render("Folder access permissions"))).toEqual({
			visible: false,
			selection: null,
		});
		expect(readCodexWorkspaceTrustScreen(await render(MODERN_CODEX_TRUST_DISCLOSURE))).toEqual({
			visible: false,
			selection: null,
		});
	});
	it("requires the exact optional Git-root warning", async () => {
		const output = renderModernCodexTrustANSI({ gitRoot: true }).replace("Note: You’re", "Caution: You’re");
		expect(readCodexWorkspaceTrustScreen(await render(output))).toEqual({ visible: true, selection: null });
	});
});
