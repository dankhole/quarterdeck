import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopLabFixture } from "../../scripts/agent-lab/desktop-fixture";
import { prepareDesktopSessionRecovery } from "../../scripts/agent-lab/desktop-session-recovery";
import { acquireRuntimeOwnership, discoverRuntimeOwner } from "../../src/server/runtime-ownership";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<DesktopLabFixture> {
	const tempRoot = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-recovery-seed-"));
	roots.push(tempRoot);
	const stateHome = join(tempRoot, "state");
	const home = join(tempRoot, "home");
	await Promise.all([mkdir(stateHome), mkdir(home)]);
	const config = {
		version: 1 as const,
		tempRoot,
		stateHome,
		userDataPath: join(tempRoot, "user-data"),
		projectPath: join(tempRoot, "project"),
		hostSimulationConfigPath: join(tempRoot, "host-simulation.json"),
		processEvidencePath: join(tempRoot, "processes.json"),
		showWindow: false,
	};
	return {
		config,
		configPath: join(tempRoot, "config.json"),
		environment: { HOME: home, PATH: process.env.PATH ?? "", QUARTERDECK_STATE_HOME: stateHome },
		manifestPath: join(tempRoot, "manifest.json"),
		forbiddenHostLaunchLogPath: join(tempRoot, "forbidden.log"),
		keepTemp: false,
		manifest: {
			schemaVersion: 1,
			surface: "electron",
			runId: "session-recovery-seed",
			status: "starting",
			appPath: "/synthetic/Quarterdeck.app",
			executablePath: "/synthetic/Quarterdeck.app/Contents/MacOS/Quarterdeck",
			artifactDir: tempRoot,
			tempRoot,
			stateHome,
			userDataPath: config.userDataPath,
			projectPath: config.projectPath,
			showWindow: false,
			agent: { mode: "fake" },
			providerVersion: null,
			mainPid: null,
			helperPid: null,
			rendererPids: [],
			processes: [],
			remainingPids: [],
			createdAt: "synthetic",
			stoppedAt: null,
			failure: null,
		},
	};
}

describe("packaged session recovery ownership fixture", () => {
	it("leaves a same-boot dirty unreleased generation belonging to an exited child", async () => {
		const test = await fixture();
		const seed = await prepareDesktopSessionRecovery(test);
		const owner = await discoverRuntimeOwner(test.config.stateHome);
		expect(owner).toMatchObject({ claim: seed.claim, released: false, processState: "dead" });
		expect(seed.claim.process.pid).not.toBe(process.pid);
		expect(seed.claim.bootIdentity).toBeTruthy();
		expect(seed.claim.previousGeneration).toBeNull();
		expect(seed.dirtyText).toBe(seed.claimText);
		expect(await readFile(seed.sessionsPath, "utf8")).toBe(seed.sessionsText);
		expect(JSON.parse(seed.sessionsText)).toMatchObject({
			"synthetic-retained-session": { pid: null, resumeSessionId: "synthetic-retained-provider-session" },
		});
		expect(await readdir(join(test.config.stateHome, "runtime-ownership", "released"))).toEqual([]);
		expect(await readdir(join(test.config.stateHome, "runtime-ownership", "successors"))).toEqual([]);
	});

	it("refuses an existing admitted owner before attempting synthetic seed takeover", async () => {
		const test = await fixture();
		const admission = await acquireRuntimeOwnership({ stateHome: test.config.stateHome, quarterdeckVersion: "test" });
		if (admission.kind !== "acquired") throw new Error("Expected a fresh fixture owner.");
		try {
			await expect(prepareDesktopSessionRecovery(test)).rejects.toThrow("new isolated fixture");
			expect((await discoverRuntimeOwner(test.config.stateHome))?.claim.generation).toBe(admission.lease.generation);
			expect(await readdir(join(test.config.stateHome, "runtime-ownership", "successors"))).toEqual([]);
		} finally {
			await admission.lease.release();
		}
	});
});
