import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeAgentLabBrowserSession } from "../../../scripts/agent-lab/browser-session";
import { runAgentLabCli } from "../../../scripts/agent-lab/cli";
import * as paths from "../../../scripts/agent-lab/paths";
import type { AgentLabManifestV1 } from "../../../scripts/agent-lab/types";

vi.mock("../../../scripts/agent-lab/browser-session", () => ({ closeAgentLabBrowserSession: vi.fn() }));

describe("Agent Lab stop browser recovery", () => {
	let root: string;
	let manifest: AgentLabManifestV1;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "quarterdeck-lab-stop-test-"));
		const runId = "abandoned-run";
		const artifactDir = join(root, runId);
		await mkdir(artifactDir);
		vi.stubEnv("QUARTERDECK_AGENT_LAB_ARTIFACT_ROOT", root);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(paths, "isProcessAlive").mockReturnValue(false);
		vi.mocked(closeAgentLabBrowserSession).mockReset().mockResolvedValue();
		manifest = {
			schemaVersion: 1,
			runId,
			status: "ready",
			repoRoot: "/synthetic/worktree",
			artifactDir,
			manifestPath: join(artifactDir, "manifest.json"),
			stopRequestPath: join(artifactDir, "stop-request.json"),
			tempRoot: join(root, "temp"),
			homePath: join(root, "home"),
			statePath: join(root, "state"),
			projectPath: join(root, "project"),
			additionalProjectPath: join(root, "secondary"),
			forbiddenHostLaunchLogPath: join(root, "forbidden-host-launches.log"),
			runtimeCapabilities: { nativeUiAvailable: false },
			projectUrl: "http://127.0.0.1:4174/project",
			runtimeUrl: "http://127.0.0.1:3597",
			webUrl: "http://127.0.0.1:4174",
			browserConfigPath: join(artifactDir, "playwright-cli.config.json"),
			browserOutputPath: join(artifactDir, "browser"),
			browserSession: `qd-${runId}`,
			scenario: "idle",
			keepTemp: true,
			supervisorPid: 90001,
			processes: { runtime: null, web: null },
			createdAt: "2026-10-22T16:31:06.000Z",
			readyAt: "2026-10-22T16:31:07.000Z",
			stoppedAt: null,
			failure: null,
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	async function stop(): Promise<void> {
		await writeFile(manifest.manifestPath, JSON.stringify(manifest));
		await runAgentLabCli(["node", "agent-lab", "stop", manifest.runId, "--json"]);
	}

	it.each(["stopped", "failed"] as const)("retries browser cleanup for a finalized %s run", async (status) => {
		manifest.status = status;
		manifest.stoppedAt = "2026-10-22T16:35:00.000Z";
		manifest.failure = status === "failed" ? "earlier failure" : null;
		if (status === "failed") await expect(stop()).rejects.toThrow("earlier failure");
		else await stop();
		expect(closeAgentLabBrowserSession).toHaveBeenCalledWith(manifest.repoRoot, manifest.browserSession, {
			mode: "owned-processes-only",
		});
	});

	it("cleans a dead supervisor's browser even when managed children still appear alive", async () => {
		manifest.processes.runtime = { pid: 90002, logPath: join(root, "runtime.log") };
		vi.mocked(paths.isProcessAlive).mockImplementation((pid) => pid === 90002);
		vi.mocked(closeAgentLabBrowserSession).mockImplementation(async () => {
			// New browser commands must already be fenced when recovery starts.
			expect(await paths.readAgentLabManifest(manifest.manifestPath)).toMatchObject({ status: "failed" });
		});
		await expect(stop()).rejects.toThrow("Managed processes still appear alive (runtime:90002)");
		expect(closeAgentLabBrowserSession).toHaveBeenCalledTimes(1);
	});

	it("waits for the live supervisor to finish cleanup after publishing a startup failure", async () => {
		manifest.status = "failed";
		manifest.failure = "startup failure";
		vi.mocked(paths.isProcessAlive).mockReturnValue(true);
		const write = vi.spyOn(paths, "writeJsonAtomic").mockImplementationOnce(async (path) => {
			expect(path).toBe(manifest.stopRequestPath);
			manifest.stoppedAt = "2026-10-22T16:35:00.000Z";
			await writeFile(manifest.manifestPath, JSON.stringify(manifest));
		});
		await expect(stop()).rejects.toThrow("startup failure");
		expect(write).toHaveBeenCalledTimes(1);
		expect(closeAgentLabBrowserSession).not.toHaveBeenCalled();
	});

	it("persists and reports residual browser cleanup failures rather than claiming a stopped run", async () => {
		manifest.status = "stopped";
		manifest.stoppedAt = "2026-10-22T16:35:00.000Z";
		vi.mocked(closeAgentLabBrowserSession).mockRejectedValue(new Error("process 80906 remains"));
		await expect(stop()).rejects.toThrow("Browser cleanup failed: process 80906 remains");
		expect(JSON.parse(await readFile(manifest.manifestPath, "utf8"))).toMatchObject({
			status: "failed",
			failure: "Browser cleanup failed: process 80906 remains",
		});
	});
});
