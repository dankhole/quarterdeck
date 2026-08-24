import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { _testing as browserActionTesting } from "../../scripts/agent-lab/browser-actions";
import { runAgentLabCli } from "../../scripts/agent-lab/cli";
import { buildAgentLabEnvironment } from "../../scripts/agent-lab/environment";
import {
	extractPromptArgument,
	parseFakeAgentCommand,
	resolveFakeAgentScenario,
} from "../../scripts/agent-lab/fake-agent-protocol";
import { resolveLoopbackPort } from "../../scripts/agent-lab/loopback-port";
import {
	AGENT_LAB_BROWSER_INSTALL_COMMAND,
	assertSafeRunId,
	createAgentLabRunId,
	getAgentBrowserLocalPaths,
	getAgentLabArtifactRoot,
	getAgentLabBrowserCachePath,
	getAgentLabBrowserCachePaths,
	prepareAgentLabBrowserCache,
	readAgentLabManifest,
} from "../../scripts/agent-lab/paths";

describe("agent-lab browser cache", () => {
	it("shares browser binaries through the primary checkout", () => {
		expect(
			getAgentLabBrowserCachePath("/repo/.quarterdeck/worktrees/task/quarterdeck", "/repo/quarterdeck/.git"),
		).toBe("/repo/quarterdeck/.git/quarterdeck/agent-lab/playwright-browsers");
	});

	it("falls back to the active checkout for nonstandard Git layouts", () => {
		expect(getAgentLabBrowserCachePath("/repo/quarterdeck", "/repo/quarterdeck.git")).toBe(
			"/repo/quarterdeck.git/quarterdeck/agent-lab/playwright-browsers",
		);
	});

	it("keeps the durable cache outside every node_modules tree", () => {
		const paths = getAgentLabBrowserCachePaths(
			"/repo/.quarterdeck/worktrees/task/quarterdeck",
			"/repo/quarterdeck/.git",
		);
		expect(paths.stablePath.split("/")).not.toContain("node_modules");
		expect(paths.legacyPath).toBe("/repo/quarterdeck/web-ui/node_modules/.cache/agent-lab-playwright");
	});

	it("resolves the same cache for two worktrees sharing a Git common directory", () => {
		const commonDirectory = "/repo/quarterdeck/.git";
		expect(getAgentLabBrowserCachePath("/worktrees/one/quarterdeck", commonDirectory)).toBe(
			getAgentLabBrowserCachePath("/worktrees/two/quarterdeck", commonDirectory),
		);
	});

	it("keeps browser profiles, daemon state, and artifacts worktree-local", () => {
		const first = getAgentBrowserLocalPaths("/worktrees/one/quarterdeck");
		const second = getAgentBrowserLocalPaths("/worktrees/two/quarterdeck");
		expect(first).toEqual({
			artifactRoot: "/worktrees/one/quarterdeck/test-results/agent-lab",
			browserHomePath: "/worktrees/one/quarterdeck/test-results/agent-lab/browser-home",
			daemonSessionPath: "/worktrees/one/quarterdeck/test-results/agent-lab/browser-daemon",
		});
		expect(second.artifactRoot).not.toBe(first.artifactRoot);
	});

	it("uses a worktree-local fallback when legacy test-results is a shared symlink", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-artifact-root-"));
		const repoRoot = join(root, "worktree");
		const sharedResults = join(root, "shared-results");
		const previousOverride = process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
		try {
			delete process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
			await mkdir(repoRoot, { recursive: true });
			await mkdir(sharedResults, { recursive: true });
			await symlink(
				sharedResults,
				join(repoRoot, "test-results"),
				process.platform === "win32" ? "junction" : "dir",
			);

			expect(getAgentLabArtifactRoot(repoRoot)).toBe(join(repoRoot, ".agent-lab-results"));
		} finally {
			if (previousOverride === undefined) {
				delete process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
			} else {
				process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT = previousOverride;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it("survives root and web dependency reinstalls", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-survival-"));
		const repoRoot = join(root, "repo");
		const commonDirectory = join(repoRoot, ".git");
		try {
			await mkdir(join(repoRoot, "node_modules"), { recursive: true });
			await mkdir(join(repoRoot, "web-ui", "node_modules"), { recursive: true });
			const prepared = await prepareAgentLabBrowserCache(repoRoot, commonDirectory);
			const sentinelPath = join(prepared.path, "cache-sentinel");
			await writeFile(sentinelPath, "browser-binary-cache\n", "utf8");
			await rm(join(repoRoot, "node_modules"), { recursive: true, force: true });
			await rm(join(repoRoot, "web-ui", "node_modules"), { recursive: true, force: true });
			expect(await readFile(sentinelPath, "utf8")).toBe("browser-binary-cache\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("migrates a complete legacy Chromium cache without deleting it", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-migration-"));
		const repoRoot = join(root, "repo");
		const commonDirectory = join(repoRoot, ".git");
		const paths = getAgentLabBrowserCachePaths(repoRoot, commonDirectory);
		const legacyInstallation = join(paths.legacyPath, "chromium-1237");
		try {
			await mkdir(legacyInstallation, { recursive: true });
			await writeFile(join(legacyInstallation, "INSTALLATION_COMPLETE"), "", "utf8");
			await writeFile(join(legacyInstallation, "browser-binary"), "complete\n", "utf8");

			const prepared = await prepareAgentLabBrowserCache(repoRoot, commonDirectory);
			expect(prepared).toEqual({ path: paths.stablePath, status: "migrated" });
			const launchPreparation = await prepareAgentLabBrowserCache(repoRoot, commonDirectory);
			expect(launchPreparation).toEqual({ path: prepared.path, status: "ready" });
			expect(await readFile(join(paths.stablePath, "chromium-1237", "browser-binary"), "utf8")).toBe("complete\n");
			expect(await readFile(join(legacyInstallation, "browser-binary"), "utf8")).toBe("complete\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not migrate a partial Playwright installation", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-partial-"));
		const repoRoot = join(root, "repo");
		const commonDirectory = join(repoRoot, ".git");
		const paths = getAgentLabBrowserCachePaths(repoRoot, commonDirectory);
		try {
			await mkdir(join(paths.legacyPath, "chromium-1237"), { recursive: true });
			await writeFile(join(paths.legacyPath, "chromium-1237", "browser-binary"), "partial\n", "utf8");
			const prepared = await prepareAgentLabBrowserCache(repoRoot, commonDirectory);
			expect(prepared).toEqual({ path: paths.stablePath, status: "empty" });
			expect(await readFile(join(paths.legacyPath, "chromium-1237", "browser-binary"), "utf8")).toBe("partial\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlink at the stable cache path without following it", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-symlink-"));
		const repoRoot = join(root, "repo");
		const commonDirectory = join(repoRoot, ".git");
		const paths = getAgentLabBrowserCachePaths(repoRoot, commonDirectory);
		const externalDirectory = join(root, "external-cache-target");
		try {
			await mkdir(externalDirectory, { recursive: true });
			await writeFile(join(externalDirectory, "sentinel"), "untouched\n", "utf8");
			await mkdir(join(commonDirectory, "quarterdeck", "agent-lab"), { recursive: true });
			await symlink(externalDirectory, paths.stablePath, process.platform === "win32" ? "junction" : "dir");

			await expect(prepareAgentLabBrowserCache(repoRoot, commonDirectory)).rejects.toThrow(
				"must be a real directory",
			);
			expect(await readFile(join(externalDirectory, "sentinel"), "utf8")).toBe("untouched\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the explicit install flow when no browser cache exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-browser-cache-empty-"));
		try {
			const prepared = await prepareAgentLabBrowserCache(join(root, "repo"), join(root, "repo", ".git"));
			expect(prepared.status).toBe("empty");
			expect(AGENT_LAB_BROWSER_INSTALL_COMMAND).toBe("npm run agent:browser -- install-browser chromium");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("agent-lab environment", () => {
	it("forwards only the small host allowlist and injects isolated paths", () => {
		const environment = buildAgentLabEnvironment(
			{
				PATH: "/host/bin",
				LANG: "en_US.UTF-8",
				OPENAI_API_KEY: "must-not-leak",
				AWS_SECRET_ACCESS_KEY: "must-not-leak",
			},
			{
				tempRoot: "/tmp/lab",
				homePath: "/tmp/lab/home",
				statePath: "/tmp/lab/state",
				projectPath: "/tmp/lab/project",
				additionalProjectPath: "/tmp/lab/project-secondary",
				fakeBinPath: "/tmp/lab/bin",
				forbiddenHostLaunchLogPath: "/tmp/lab/forbidden-host-launches.log",
				repoRoot: "/repo",
				tsxCliPath: "/repo/node_modules/tsx/cli.mjs",
				fakeCodexPath: "/repo/scripts/fake-codex.ts",
				cliEntrypointPath: "/repo/src/cli.ts",
				runtimePort: 35_001,
				webPort: 41_731,
				scenario: "idle",
			},
		);

		expect(environment.OPENAI_API_KEY).toBeUndefined();
		expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(environment.HOME).toBe("/tmp/lab/home");
		expect(environment.QUARTERDECK_STATE_HOME).toBe("/tmp/lab/state");
		expect(environment.QUARTERDECK_RUNTIME_PORT).toBe("35001");
		expect(environment.QUARTERDECK_AGENT_LAB_ADDITIONAL_PROJECT).toBe("/tmp/lab/project-secondary");
		expect(environment.PATH).toBe(["/tmp/lab/bin", "/host/bin"].join(delimiter));
	});
});

describe("agent-lab fake agent protocol", () => {
	it("prefers a prompt scenario directive over the run default", () => {
		expect(resolveFakeAgentScenario("Please test [agent-lab:needs-input] now", "idle")).toBe("needs-input");
		expect(resolveFakeAgentScenario("No directive", "terminal-stress")).toBe("terminal-stress");
	});

	it("extracts only the prompt after Codex's explicit option separator", () => {
		expect(extractPromptArgument(["--enable", "hooks", "--", "- investigate", "the UI"])).toBe(
			"- investigate the UI",
		);
		expect(extractPromptArgument(["resume", "session-id"])).toBe("");
	});

	it("parses bounded deterministic commands", () => {
		expect(parseFakeAgentCommand("/approval-overlay")).toEqual({ kind: "approval-overlay" });
		expect(parseFakeAgentCommand("/write nested/result.txt hello world")).toEqual({
			kind: "write",
			relativePath: "nested/result.txt",
			contents: "hello world",
		});
		expect(parseFakeAgentCommand("/delay-review 999999 done")).toEqual({
			kind: "delay-review",
			delayMs: 30_000,
			message: "done",
		});
		expect(parseFakeAgentCommand("/spam nope")).toEqual({ kind: "spam", count: 100 });
	});
});

describe("agent-lab run ids", () => {
	it("creates filesystem-safe, sortable ids", () => {
		const runId = createAgentLabRunId("Visual Debug", new Date("2026-08-23T12:34:56.789Z"));
		expect(runId).toMatch(/^visual-debug-20260823T123456Z-[a-f0-9]{6}$/);
		expect(assertSafeRunId(runId)).toBe(runId);
		expect(() => assertSafeRunId("../escape")).toThrow("Invalid agent-lab run id");
	});
});

describe("agent-lab manifest compatibility", () => {
	it("keeps version-1 runs readable for status, list, and stop lifecycle operations", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-agent-lab-manifest-test-"));
		const runDirectory = join(root, "legacy-run");
		const manifestPath = join(runDirectory, "manifest.json");
		const previousArtifactRoot = process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await mkdir(runDirectory, { recursive: true });
			process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT = root;
			await writeFile(
				manifestPath,
				`${JSON.stringify({
					schemaVersion: 1,
					runId: "legacy-run",
					status: "stopped",
					repoRoot: "/repo",
					artifactDir: root,
					manifestPath,
					stopRequestPath: join(root, "stop-request.json"),
					tempRoot: join(root, "temp"),
					homePath: join(root, "home"),
					statePath: join(root, "state"),
					projectPath: join(root, "project"),
					additionalProjectPath: join(root, "project-secondary"),
					forbiddenHostLaunchLogPath: join(root, "forbidden-host-launches.log"),
					runtimeCapabilities: { nativeUiAvailable: false },
					projectUrl: "http://127.0.0.1:4174/project",
					runtimeUrl: "http://127.0.0.1:3597",
					webUrl: "http://127.0.0.1:4174",
					browserConfigPath: join(root, "browser.json"),
					browserOutputPath: join(root, "browser"),
					browserSession: "legacy-browser",
					scenario: "idle",
					keepTemp: true,
					supervisorPid: process.pid,
					processes: { runtime: null, web: null },
					createdAt: "2026-08-23T12:34:56.000Z",
					readyAt: "2026-08-23T12:34:57.000Z",
					stoppedAt: "2026-08-23T12:35:00.000Z",
					failure: null,
				})}\n`,
				"utf8",
			);

			await expect(readAgentLabManifest(manifestPath)).resolves.toMatchObject({
				schemaVersion: 1,
				runId: "legacy-run",
				status: "stopped",
				stopRequestPath: join(root, "stop-request.json"),
			});

			for (const args of [
				["node", "agent-lab", "status", "legacy-run", "--json"],
				["node", "agent-lab", "list", "--json"],
				["node", "agent-lab", "stop", "legacy-run", "--json"],
			]) {
				stdout.mockClear();
				await runAgentLabCli(args);
				expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain('"runId": "legacy-run"');
			}
			stdout.mockClear();
			await runAgentLabCli(["node", "agent-lab", "snapshot", "legacy-run", "--label", "legacy", "--json"]);
			expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain('"label": "legacy"');

			const versionOneManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
			await writeFile(
				manifestPath,
				`${JSON.stringify({
					...versionOneManifest,
					schemaVersion: 2,
					hostEventLedgerPath: join(root, "host-events.jsonl"),
					runtimeCapabilities: { nativeUiAvailable: false, hostIntegrationMode: "simulated" },
				})}\n`,
				"utf8",
			);
			await expect(readAgentLabManifest(manifestPath)).resolves.toMatchObject({
				schemaVersion: 2,
				runId: "legacy-run",
			});
			await expect(runAgentLabCli(["node", "agent-lab", "restart-runtime", "legacy-run", "--json"])).rejects.toThrow(
				"predates same-state runtime restart support",
			);
		} finally {
			stdout.mockRestore();
			if (previousArtifactRoot === undefined) {
				delete process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT;
			} else {
				process.env.QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT = previousArtifactRoot;
			}
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("agent-lab loopback ports", () => {
	it("allocates an ephemeral port through the shared supervisor boundary", async () => {
		const port = await resolveLoopbackPort(null, "test");
		expect(port).toBeGreaterThan(0);
		expect(port).toBeLessThanOrEqual(65_535);
	});
});

describe("agent-lab browser action summaries", () => {
	it("keeps synthetic interaction text while aliasing lab paths", () => {
		const manifest = {
			artifactDir: "/repo/test-results/agent-lab/run-1",
			tempRoot: "/tmp/lab-run",
			repoRoot: "/repo",
		} as Parameters<typeof browserActionTesting.summarizeArguments>[0];
		const summary = browserActionTesting.summarizeArguments(manifest, [
			"-s=qd-run-1",
			"fill",
			"e12",
			"synthetic prompt",
			"--filename=/repo/test-results/agent-lab/run-1/browser/checkpoint.png",
		]);
		expect(summary).toContain("synthetic prompt");
		expect(summary).toContain("--filename=$LAB_ARTIFACT/browser/checkpoint.png");
		expect(summary.join(" ")).not.toContain("/repo/test-results");
	});
});
