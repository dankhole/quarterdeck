import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	DEFAULT_PROMPT_SHORTCUTS,
	loadRuntimeConfig,
	normalizePromptShortcuts,
	updateRuntimeConfig,
} from "../../../src/config";
import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv } from "./runtime-config-helpers";

describe.sequential("prompt shortcuts config persistence", () => {
	it("returns default prompt shortcuts when none configured", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-prompt-shortcuts-default-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(null);
				expect(state.promptShortcuts).toHaveLength(2);
				expect(state.promptShortcuts[0]?.label).toBe("Commit");
				expect(state.promptShortcuts[0]?.prompt).toContain("commit your working changes");
				expect(state.promptShortcuts[1]?.label).toBe("Squash Merge");
				expect(state.promptShortcuts[1]?.prompt).toContain("commit-tree");
			});
		} finally {
			cleanupHome();
		}
	});

	it("keeps the default landing workflow portable across supported shells", () => {
		const squashMergePrompt = DEFAULT_PROMPT_SHORTCUTS.find((shortcut) => shortcut.label === "Squash Merge")?.prompt;

		expect(squashMergePrompt).toContain("git worktree list --porcelain");
		expect(squashMergePrompt).toContain("Inspect the output block by block");
		expect(squashMergePrompt).not.toContain("| awk");
	});

	it("migrates the persisted legacy Unix-only landing workflow", () => {
		const legacySection = [
			"Parse correctly by extracting the worktree path from the block that contains the matching branch:",
			"",
			"```bash",
			'git worktree list --porcelain | awk -v target="branch refs/heads/<target>" \'/^worktree /{wt=$0; sub(/^worktree /,"",wt)} $0==target{print wt}\'',
			"```",
			"",
			"If this prints a path (and it's not the current worktree), check for uncommitted work **now** — before `update-ref` changes anything:",
		].join("\n");

		const [migrated] = normalizePromptShortcuts([{ label: "Squash Merge", prompt: legacySection }]);
		expect(migrated?.prompt).toContain("git worktree list --porcelain");
		expect(migrated?.prompt).toContain("Inspect the output block by block");
		expect(migrated?.prompt).not.toContain("| awk");
	});

	it("persists and loads prompt shortcuts", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-prompt-shortcuts-persist-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(null);
				const customShortcuts = [
					{ label: "Ship", prompt: "push to main" },
					{ label: "Fix", prompt: "fix the bug" },
				];
				await updateRuntimeConfig(null, { promptShortcuts: customShortcuts });

				const reloaded = await loadRuntimeConfig(null);
				expect(reloaded.promptShortcuts).toHaveLength(4);
				expect(reloaded.promptShortcuts[0]?.label).toBe("Ship");
				expect(reloaded.promptShortcuts[0]?.prompt).toBe("push to main");
				expect(reloaded.promptShortcuts[1]?.label).toBe("Fix");
				expect(reloaded.promptShortcuts[1]?.prompt).toBe("fix the bug");
				expect(reloaded.promptShortcuts[2]?.label).toBe("Commit");
				expect(reloaded.promptShortcuts[3]?.label).toBe("Squash Merge");

				const globalConfigRaw = readFileSync(join(tempHome, ".quarterdeck", "config.json"), "utf8");
				const globalConfig = JSON.parse(globalConfigRaw) as { promptShortcuts?: unknown[] };
				expect(globalConfig.promptShortcuts).toHaveLength(2);
			});
		} finally {
			cleanupHome();
		}
	});

	it("filters invalid prompt shortcuts", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-prompt-shortcuts-invalid-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(null);
				const configPath = join(tempHome, ".quarterdeck", "config.json");
				writeFileSync(
					configPath,
					JSON.stringify({
						promptShortcuts: [
							{ label: "", prompt: "test" },
							{ label: "Valid", prompt: "" },
							{ label: "Good", prompt: "real prompt" },
						],
					}),
				);

				const reloaded = await loadRuntimeConfig(null);
				expect(reloaded.promptShortcuts).toHaveLength(3);
				expect(reloaded.promptShortcuts[0]?.label).toBe("Good");
				expect(reloaded.promptShortcuts[1]?.label).toBe("Commit");
				expect(reloaded.promptShortcuts[2]?.label).toBe("Squash Merge");
			});
		} finally {
			cleanupHome();
		}
	});

	it("falls back to defaults when all shortcuts are invalid", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-prompt-shortcuts-all-invalid-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(null);
				const configPath = join(tempHome, ".quarterdeck", "config.json");
				writeFileSync(configPath, JSON.stringify({ promptShortcuts: [{ label: "", prompt: "" }] }));

				const reloaded = await loadRuntimeConfig(null);
				expect(reloaded.promptShortcuts).toHaveLength(2);
				expect(reloaded.promptShortcuts[0]?.label).toBe("Commit");
			});
		} finally {
			cleanupHome();
		}
	});

	it("returns defaults when promptShortcuts is not an array", () => {
		expect(normalizePromptShortcuts("not-an-array" as unknown as null)).toEqual([...DEFAULT_PROMPT_SHORTCUTS]);
		expect(normalizePromptShortcuts(42 as unknown as null)).toEqual([...DEFAULT_PROMPT_SHORTCUTS]);
		expect(normalizePromptShortcuts({ label: "X", prompt: "Y" } as unknown as null)).toEqual([
			...DEFAULT_PROMPT_SHORTCUTS,
		]);
		expect(normalizePromptShortcuts(null)).toEqual([...DEFAULT_PROMPT_SHORTCUTS]);
		expect(normalizePromptShortcuts(undefined)).toEqual([...DEFAULT_PROMPT_SHORTCUTS]);
	});
});
