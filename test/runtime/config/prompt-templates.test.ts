import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_RUNTIME_CONFIG_STATE,
	loadGlobalRuntimeConfig,
	saveRuntimeConfig,
	toGlobalRuntimeConfigState,
	updateGlobalRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config";
import { createDefaultRuntimeConfigSaveRequest } from "../../utilities/runtime-config-factory";
import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv } from "./runtime-config-helpers";

const customTemplates = {
	commitPromptTemplate: "  Custom commit instructions\nKeep formatting.\n",
	openPrPromptTemplate: "Custom PR instructions",
	worktreeSystemPromptTemplate: "Custom worktree instructions",
};

describe("runtime prompt templates", { concurrent: false }, () => {
	it("preserves custom templates in saves, global projections, and subsequent unrelated updates", async () => {
		const { path: home, cleanup } = createTempDir("quarterdeck-prompt-templates-");
		try {
			await withTemporaryEnv({ home }, async () => {
				const saved = await saveRuntimeConfig(null, createDefaultRuntimeConfigSaveRequest(customTemplates));
				expect(saved).toMatchObject(customTemplates);
				const projected = toGlobalRuntimeConfigState(saved);
				expect(projected).toMatchObject(customTemplates);
				const updatedTemplates = { ...customTemplates, openPrPromptTemplate: "Updated PR instructions" };
				const updated = await updateRuntimeConfig(null, updatedTemplates);
				expect(updated).toMatchObject(updatedTemplates);
				const unrelated = await updateGlobalRuntimeConfig(updated, {
					statuslineEnabled: !updated.statuslineEnabled,
				});
				expect(unrelated).toMatchObject(updatedTemplates);
				expect(JSON.parse(readFileSync(unrelated.globalConfigPath, "utf8"))).toMatchObject(updatedTemplates);
				expect(await loadGlobalRuntimeConfig()).toMatchObject(updatedTemplates);
			});
		} finally {
			cleanup();
		}
	});

	it("normalizes blank templates to defaults consistently after saving and loading", async () => {
		const { path: home, cleanup } = createTempDir("quarterdeck-blank-prompt-templates-");
		try {
			await withTemporaryEnv({ home }, async () => {
				await saveRuntimeConfig(null, createDefaultRuntimeConfigSaveRequest(customTemplates));
				const updated = await updateRuntimeConfig(null, {
					commitPromptTemplate: "",
					openPrPromptTemplate: "   ",
					worktreeSystemPromptTemplate: "\n\t",
				});
				const expected = {
					commitPromptTemplate: DEFAULT_RUNTIME_CONFIG_STATE.commitPromptTemplate,
					openPrPromptTemplate: DEFAULT_RUNTIME_CONFIG_STATE.openPrPromptTemplate,
					worktreeSystemPromptTemplate: DEFAULT_RUNTIME_CONFIG_STATE.worktreeSystemPromptTemplate,
				};
				expect(updated).toMatchObject(expected);
				expect(await loadGlobalRuntimeConfig()).toMatchObject(expected);
			});
		} finally {
			cleanup();
		}
	});
});
