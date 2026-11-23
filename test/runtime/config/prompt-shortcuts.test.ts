import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	DEFAULT_COMMIT_PROMPT_TEMPLATE,
	loadRuntimeConfig,
	normalizePromptShortcuts,
	updateRuntimeConfig,
} from "../../../src/config";
import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv } from "./runtime-config-helpers";

const squashMerge = {
	label: "Squash Merge",
	prompt: "merge in latest main/master and then squash merge our changes onto main/master",
};
const implement = {
	label: "Implement",
	prompt:
		"Plan out a full implementation. Then kick off implementation of that plan in parallel with subagents. while implantation starts use a sunb agent to review the paln for any misses or gotchas. when done run review agents in parralell and address all findings. Use appropriote models and thinking levels for all agents.",
};
const builtIns = [squashMerge, implement];
const retiredCommit = {
	label: "Commit",
	prompt: `When you are finished with the task, commit your working changes.

First, check your current git state: run \`git status\` and \`git branch --show-current\`.

- If you are on a branch, stage and commit your changes directly on that branch. Write a clear, descriptive commit message that summarizes the changes and their purpose.
- If you are on a detached HEAD, create a new branch from the current commit first (e.g. \`git checkout -b <descriptive-branch-name>\`), then stage and commit. Report that a new branch was created.
- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not cherry-pick, rebase, or push to other branches. Just commit to your current branch.

Report:
- Branch name
- Final commit hash
- Final commit message
- Whether a new branch was created (detached HEAD case)`,
};
const portablePrompt = readFileSync(new URL("legacy-squash-merge-prompt.txt", import.meta.url), "utf8").trim();
const unixOnlyPrompt = portablePrompt.replace(
	/git worktree list --porcelain\n```\n\nInspect the output[^\n]*\n\nIf a matching block provides a path/,
	[
		'git worktree list --porcelain | awk -v target="branch refs/heads/<target>" \'/^worktree /{wt=$0; sub(/^worktree /,"",wt)} $0==target{print wt}\'',
		"```",
		"",
		"If this prints a path",
	].join("\n"),
);
const originalPrompt = unixOnlyPrompt
	.replace(
		"# Files this worktree changed since the branch point\ngit diff --name-only <target>...HEAD",
		"MERGE_BASE=$(git merge-base <target> HEAD)\n# Files this worktree changed\ngit diff --name-only $MERGE_BASE HEAD",
	)
	.replace("git diff --name-only HEAD...<target>", () => "git diff --name-only $MERGE_BASE <target>");

async function withConfig(run: (configPath: string) => Promise<void>, seed?: object): Promise<void> {
	const { path: home, cleanup } = createTempDir("quarterdeck-home-prompt-shortcuts-");
	try {
		const configPath = join(home, ".quarterdeck", "config.json");
		if (seed) {
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, JSON.stringify(seed));
		}
		await withTemporaryEnv({ home }, () => run(configPath));
	} finally {
		cleanup();
	}
}

describe("prompt shortcuts config persistence", { concurrent: false }, () => {
	it("loads exactly the two built-ins with the requested text on a fresh install", async () => {
		await withConfig(async () => {
			const state = await loadRuntimeConfig(null);
			expect(state.promptShortcuts).toEqual(builtIns);
			expect(state.commitPromptTemplate).toBe(DEFAULT_COMMIT_PROMPT_TEMPLATE);
		});
	});

	it.each([
		["portable", portablePrompt],
		["Unix-only", unixOnlyPrompt],
		["original", originalPrompt],
	])("upgrades a materialized %s Squash Merge and removes the old Commit", async (_version, oldPrompt) => {
		const ship = { label: "Ship", prompt: "push to main" };
		const fix = { label: "Fix", prompt: "fix the bug" };
		const seed = {
			promptShortcuts: [retiredCommit, ship, { label: "Squash Merge", prompt: oldPrompt }, fix],
			hiddenDefaultPromptShortcuts: [" commit "],
		};
		await withConfig(async (configPath) => {
			const expected = [ship, squashMerge, fix, implement];
			const loaded = await loadRuntimeConfig(null);
			expect(loaded.promptShortcuts).toEqual(expected);
			expect(loaded.hiddenDefaultPromptShortcuts).toEqual([]);
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(seed);

			await updateRuntimeConfig(null, { codeNavigationEnabled: !loaded.codeNavigationEnabled });
			const persisted = JSON.parse(readFileSync(configPath, "utf8"));
			expect(persisted.promptShortcuts).toEqual(expected);
			expect(persisted.hiddenDefaultPromptShortcuts).toBeUndefined();
			expect((await loadRuntimeConfig(null)).promptShortcuts).toEqual(expected);
		}, seed);
	});

	it("preserves customized old prompts, differently named copies, and row order", async () => {
		const custom = [
			{ label: "Commit", prompt: `${retiredCommit.prompt}\nAlso explain the test results.` },
			{ label: "Resolve", prompt: "fix the bug" },
			{ label: "Squash Merge", prompt: `${unixOnlyPrompt}\nAlso open a pull request.` },
			{ label: "Git Commit", prompt: retiredCommit.prompt },
		];
		await withConfig(
			async () => expect((await loadRuntimeConfig(null)).promptShortcuts).toEqual([...custom, implement]),
			{ promptShortcuts: custom },
		);
	});

	it("preserves an intentional save of retired built-in text across reloads", async () => {
		const saved = [retiredCommit, { label: "Squash Merge", prompt: portablePrompt }];
		await withConfig(async () => {
			const expected = [...saved, implement];
			const updated = await updateRuntimeConfig(null, { promptShortcuts: saved });
			expect(updated.promptShortcuts).toEqual(expected);
			expect((await loadRuntimeConfig(null)).promptShortcuts).toEqual(expected);
		});
	});

	it("keeps active hidden choices and restores only current built-ins on reset", async () => {
		const customCommit = { label: "Commit", prompt: "commit, then show the diff" };
		const editedImplement = { label: "Implement", prompt: "Implement without subagents" };
		await withConfig(
			async () => {
				const loaded = await loadRuntimeConfig(null);
				expect(loaded.promptShortcuts).toEqual([editedImplement, customCommit]);
				expect(loaded.hiddenDefaultPromptShortcuts).toEqual(["squash merge"]);

				const reset = await updateRuntimeConfig(null, {
					promptShortcuts: [customCommit],
					hiddenDefaultPromptShortcuts: [],
				});
				expect(reset.promptShortcuts).toEqual([customCommit, ...builtIns]);
				expect((await loadRuntimeConfig(null)).promptShortcuts).toEqual(reset.promptShortcuts);
			},
			{
				promptShortcuts: [editedImplement, customCommit],
				hiddenDefaultPromptShortcuts: ["Commit", "Squash Merge"],
			},
		);
	});

	it("persists and loads custom prompt shortcuts ahead of missing defaults", async () => {
		await withConfig(async (configPath) => {
			const customShortcuts = [
				{ label: "Ship", prompt: "push to main" },
				{ label: "Fix", prompt: "fix the bug" },
			];
			await updateRuntimeConfig(null, { promptShortcuts: customShortcuts });

			expect((await loadRuntimeConfig(null)).promptShortcuts).toEqual([...customShortcuts, ...builtIns]);
			expect(JSON.parse(readFileSync(configPath, "utf8")).promptShortcuts).toEqual(customShortcuts);
		});
	});

	it("filters invalid prompt shortcuts", async () => {
		const good = { label: "Good", prompt: "real prompt" };
		await withConfig(
			async () => expect((await loadRuntimeConfig(null)).promptShortcuts).toEqual([good, ...builtIns]),
			{ promptShortcuts: [{ label: "", prompt: "test" }, { label: "Valid", prompt: "" }, good] },
		);
	});

	it("uses the built-ins when no valid shortcuts are configured", () => {
		expect(normalizePromptShortcuts([{ label: "", prompt: "" }])).toEqual(builtIns);
		expect(normalizePromptShortcuts("not-an-array" as unknown as null)).toEqual(builtIns);
		expect(normalizePromptShortcuts(null)).toEqual(builtIns);
		expect(normalizePromptShortcuts(undefined)).toEqual(builtIns);
	});
});
