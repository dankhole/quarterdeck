import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { prepareDesktopLabFixture } from "../../scripts/agent-lab/desktop-fixture";
import type * as desktopProvider from "../../scripts/agent-lab/desktop-provider";
import { removeDesktopProviderProfiles } from "../../scripts/agent-lab/desktop-provider";
import type * as realClaude from "../../scripts/agent-lab/real-claude";
import type * as realCodex from "../../scripts/agent-lab/real-codex";

// Exercise the existing profile staging with synthetic credentials only. Never
// invoke a installed provider or access a real sign-in during these tests.
vi.mock("../../scripts/agent-lab/real-codex", async (importOriginal) => {
	const original = await importOriginal<typeof realCodex>();
	return {
		...original,
		prepareIsolatedRealCodexAgent: (
			agent: Parameters<typeof original.prepareIsolatedRealCodexAgent>[0],
			root: string,
			source: NodeJS.ProcessEnv,
		) => original.prepareIsolatedRealCodexAgent(agent, root, source, { validateAuthentication: async () => {} }),
	};
});
vi.mock("../../scripts/agent-lab/real-claude", async (importOriginal) => {
	const original = await importOriginal<typeof realClaude>();
	return {
		...original,
		prepareIsolatedRealClaudeAgent: (
			agent: Parameters<typeof original.prepareIsolatedRealClaudeAgent>[0],
			root: string,
			source: NodeJS.ProcessEnv,
		) => original.prepareIsolatedRealClaudeAgent(agent, root, source, { validateAuthentication: async () => {} }),
	};
});
vi.mock("../../scripts/agent-lab/desktop-provider", async (importOriginal) => {
	const original = await importOriginal<typeof desktopProvider>();
	return { ...original, readDesktopProviderVersion: async () => "1.2.3" };
});

describe.skipIf(process.platform !== "darwin")("desktop real-provider fixture isolation", () => {
	it.each(["real-codex", "real-claude"] as const)(
		"stages %s privately and never copies credentials into artifacts",
		async (mode) => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-provider-test-"));
			let disposableRoot: string | undefined;
			try {
				const appPath = join(root, "Quarterdeck.app");
				const executablePath = join(appPath, "Contents", "MacOS", "Quarterdeck");
				await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
				await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
				await chmod(executablePath, 0o755);
				const sourceProfile = join(root, "source-profile");
				await mkdir(sourceProfile);
				const credentialName = mode === "real-codex" ? "auth.json" : ".credentials.json";
				const sourceCredentialPath = join(sourceProfile, credentialName);
				await writeFile(sourceCredentialPath, "synthetic-token-not-real", { mode: 0o600 });
				const fixture = await prepareDesktopLabFixture({
					appPath,
					agentMode: mode,
					keepTemp: true,
					artifactRoot: join(root, "artifacts"),
					sourceEnvironment: {
						PATH: process.env.PATH,
						CODEX_HOME: sourceProfile,
						CLAUDE_CONFIG_DIR: sourceProfile,
						OPENAI_API_KEY: "synthetic-env-secret",
					},
				});
				disposableRoot = fixture.config.tempRoot;
				expect(fixture.manifest.agent.mode).toBe(mode);
				expect(fixture.manifest.providerVersion).toBe("1.2.3");
				expect(fixture.environment.QUARTERDECK_AGENT_LAB_ALLOWED_AGENT_IDS).toBe(
					mode === "real-codex" ? "codex" : "claude",
				);
				expect(fixture.environment.OPENAI_API_KEY).toBeUndefined();
				const stagedProfile = join(fixture.config.tempRoot, mode === "real-codex" ? "codex-home" : "claude-config");
				expect(await readFile(join(stagedProfile, credentialName), "utf8")).toBe("synthetic-token-not-real");
				const artifact = await readFile(fixture.manifestPath, "utf8");
				expect(artifact).not.toContain("synthetic-token-not-real");
				expect(artifact).not.toContain("source-profile");
				expect(artifact).not.toContain("codexHomePath");
				expect(artifact).not.toContain("claudeConfigDirPath");
				await removeDesktopProviderProfiles(fixture.config.tempRoot);
				await expect(access(stagedProfile)).rejects.toThrow();
				await expect(access(fixture.config.tempRoot)).resolves.toBeUndefined();
				expect(await readFile(sourceCredentialPath, "utf8")).toBe("synthetic-token-not-real");
			} finally {
				if (disposableRoot) await rm(disposableRoot, { recursive: true, force: true });
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
