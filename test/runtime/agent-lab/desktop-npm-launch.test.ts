import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopLabFixture } from "../../../scripts/agent-lab/desktop-fixture";
import { assertDesktopNpmInitialProject } from "../../../scripts/agent-lab/desktop-npm-launch";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<DesktopLabFixture> {
	const tempRoot = await mkdtemp(join(tmpdir(), "quarterdeck-npm-initial-"));
	roots.push(tempRoot);
	const config = {
		version: 1 as const,
		tempRoot,
		stateHome: join(tempRoot, "state"),
		projectPath: join(tempRoot, "cwd-project"),
		userDataPath: join(tempRoot, "profile"),
		hostSimulationConfigPath: join(tempRoot, "host.json"),
		processEvidencePath: join(tempRoot, "processes.json"),
	};
	const requestedProject = join(tempRoot, "requested-project");
	await mkdir(join(config.stateHome, "projects"), { recursive: true });
	await writeFile(
		join(config.stateHome, "projects/index.json"),
		JSON.stringify({
			entries: {
				cwd: { projectId: "cwd-id", repoPath: config.projectPath },
				requested: { projectId: "requested-id", repoPath: requestedProject },
			},
		}),
	);
	const appPath = join(tempRoot, "Quarterdeck.app");
	return {
		config,
		configPath: join(tempRoot, "lab.json"),
		environment: {},
		manifestPath: join(tempRoot, "manifest.json"),
		forbiddenHostLaunchLogPath: join(tempRoot, "forbidden.log"),
		keepTemp: false,
		launchRequest: {
			schemaVersion: 1,
			version: "0.12.8",
			arch: "arm64",
			appPath,
			buildId: "synthetic",
			appAsarSha256: "a".repeat(64),
			stateHome: config.stateHome,
			projectPath: requestedProject,
		},
		manifest: {
			schemaVersion: 1,
			surface: "electron",
			runId: "npm-initial-test",
			status: "ready",
			appPath,
			executablePath: join(appPath, "Contents/MacOS/Quarterdeck"),
			artifactDir: tempRoot,
			...config,
			showWindow: false,
			agent: { mode: "fake" },
			providerVersion: null,
			mainPid: 100,
			helperPid: 101,
			rendererPids: [],
			processes: [],
			remainingPids: [],
			createdAt: "synthetic",
			stoppedAt: null,
			failure: null,
		},
	};
}

function page(projectId: string): Page {
	return {
		url: () => `app://quarterdeck/${projectId}`,
		locator: () => ({ isVisible: async () => true }),
	} as unknown as Page;
}

describe("packaged npm initial handoff evidence", () => {
	it("requires the explicit requested project instead of the runtime's auto-registered cwd project", async () => {
		const input = await fixture();
		vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(25_001);
		await expect(assertDesktopNpmInitialProject(page("cwd-id"), input)).rejects.toThrow(
			"initial typed project handoff",
		);
	});

	it("accepts the distinct requested project selected by the initial typed handoff", async () => {
		await expect(assertDesktopNpmInitialProject(page("requested-id"), await fixture())).resolves.toBe("requested-id");
	});

	it("rejects a scenario whose first request could be satisfied by cwd auto-registration", async () => {
		const input = await fixture();
		if (!input.launchRequest) throw new Error("Missing test launch request.");
		input.launchRequest.projectPath = input.config.projectPath;
		await expect(assertDesktopNpmInitialProject(page("cwd-id"), input)).rejects.toThrow(
			"must differ from the synthetic runtime cwd",
		);
	});
});
