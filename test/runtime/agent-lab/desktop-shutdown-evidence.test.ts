import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopLabFixture } from "../../../scripts/agent-lab/desktop-fixture";
import {
	captureDesktopShutdownEvidence,
	DESKTOP_SHUTDOWN_CAPTURE_LIMITS,
} from "../../../scripts/agent-lab/desktop-shutdown-evidence";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";
import type { DiagnosticRecordEnvelope } from "../../../src/core/api/diagnostics";

vi.mock("node:fs/promises", { spy: true });

const MAIN_ID = "32f379c7-b8bc-431c-b9d6-11b959ce1f7a";
const HELPER_ID = "54f379c7-b8bc-431c-b9d6-11b959ce1f7a";
const OTHER_ID = "65f379c7-b8bc-431c-b9d6-11b959ce1f7a";
const TIME = "2026-10-02T00:29:00.000Z";
const TOKEN = "private-diagnostic-token-canary-123456789";
const main: DesktopLabProcess = { pid: 100, parentPid: 90, startedAt: TIME, command: "private-main-argv" };
const helper: DesktopLabProcess = { pid: 101, parentPid: 100, startedAt: TIME, command: "private-helper-argv" };
const options = { attemptedAt: TIME, timedOutAt: TIME, originalMain: main, helper };
const state = {
	surface: "product",
	quitting: true,
	window: { present: true, visible: false, focused: false },
	runtime: { phase: "stopping", helperPid: helper.pid, generation: MAIN_ID, ownership: "owned" },
	update: { phase: "disabled", pending: false, reason: "synthetic" },
};

function record(instanceId: string, sequence: number, name: string, payload: unknown): DiagnosticRecordEnvelope {
	return {
		version: 1,
		id: `${instanceId}:${sequence}`,
		sequence,
		timestamp: Date.parse(TIME) + sequence,
		monotonicOffsetMs: sequence,
		runtimeInstanceId: instanceId,
		source: "runtime",
		kind: "event",
		level: "info",
		name,
		context: { taskId: "private-task-content", operationId: "private-operation-content" },
		payload,
	};
}

describe("desktop shutdown evidence preservation", () => {
	let root: string;
	let fixture: DesktopLabFixture;
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "desktop-shutdown-evidence-")));
		const tempRoot = join(root, "fixture");
		const stateHome = join(tempRoot, "state");
		const artifactDir = join(root, "artifacts");
		await Promise.all([fs.mkdir(stateHome, { recursive: true }), fs.mkdir(artifactDir)]);
		const config = {
			version: 1 as const,
			tempRoot,
			stateHome,
			userDataPath: join(tempRoot, "profile"),
			projectPath: join(tempRoot, "project"),
			hostSimulationConfigPath: join(tempRoot, "host.json"),
			processEvidencePath: join(tempRoot, "processes.json"),
		};
		fixture = {
			config,
			configPath: join(tempRoot, "config.json"),
			manifestPath: join(artifactDir, "manifest.json"),
			environment: { PRIVATE_ENV_CANARY: "private-environment-value" },
			keepTemp: false,
			forbiddenHostLaunchLogPath: join(artifactDir, "forbidden.log"),
			manifest: {
				schemaVersion: 1,
				surface: "electron",
				runId: "synthetic-shutdown",
				status: "stopping",
				appPath: join(root, "Synthetic.app"),
				executablePath: join(root, "Synthetic.app/Contents/MacOS/Synthetic"),
				artifactDir,
				...config,
				showWindow: false,
				agent: { mode: "fake" },
				providerVersion: null,
				mainPid: main.pid,
				helperPid: helper.pid,
				rendererPids: [],
				processes: [main, helper],
				remainingPids: [],
				createdAt: TIME,
				stoppedAt: null,
				failure: null,
			},
		};
		await fs.writeFile(
			config.processEvidencePath,
			JSON.stringify({
				version: 1,
				appPid: main.pid,
				helperPid: helper.pid,
				generation: MAIN_ID,
				runtimeOrigin: "http://127.0.0.1:51342",
				phase: "stopping",
			}),
		);
	});
	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});
	async function instance(id: string, pid: number, processKind: "runtime" | "desktop", records: unknown[]) {
		const directory = join(fixture.config.stateHome, "diagnostics", "instances", id);
		const journal = join(directory, "journal");
		await fs.mkdir(journal, { recursive: true });
		const descriptor = {
			version: 1,
			runtimeInstanceId: id,
			pid,
			processKind,
			status: "stopping",
			host: processKind === "desktop" ? null : "127.0.0.1",
			port: processKind === "desktop" ? null : 51342,
			quarterdeckVersion: "0.12.8",
			nodeMajorVersion: 22,
			platform: "mac",
			startedAt: TIME,
			readyAt: TIME,
			stoppedAt: null,
			diagnosticToken: TOKEN,
			journalDirectory: journal,
			failure: "private-failure-message",
		};
		await fs.writeFile(join(directory, "runtime.json"), JSON.stringify(descriptor));
		await fs.writeFile(
			join(journal, "records-000001.jsonl"),
			`${records.map((value) => JSON.stringify(value)).join("\n")}\n`,
		);
		return { directory, journal, descriptor };
	}

	it("preserves exact main/helper shutdown correlation and excludes credentials, content, argv, and context", async () => {
		await instance(MAIN_ID, main.pid, "desktop", [
			record(MAIN_ID, 1, "desktop.shutdown", {
				event: { kind: "shutdown", phase: "requested", intent: "quit" },
				state,
			}),
			record(MAIN_ID, 2, "desktop.generation", {
				event: { kind: "generation", phase: "stopping", helperPid: helper.pid, generation: MAIN_ID },
				state,
			}),
			record(MAIN_ID, 3, "desktop.shutdown", {
				event: {
					kind: "shutdown",
					phase: "failed",
					outcome: {
						status: "incomplete",
						safeToExit: false,
						safeToReleaseOwnership: false,
						reasons: ["deadline"],
					},
				},
				state,
			}),
			record(MAIN_ID, 4, "runtime.log", { prompt: "private-prompt-content" }),
			record(MAIN_ID, 5, "desktop.shutdown", {
				event: { kind: "shutdown", phase: "cancelled", prompt: TOKEN },
				state,
			}),
			record(OTHER_ID, 6, "desktop.shutdown", { event: { kind: "shutdown", phase: "completed" }, state }),
		]);
		await instance(HELPER_ID, helper.pid, "runtime", [
			record(HELPER_ID, 1, "desktop.shutdown", {
				event: { kind: "shutdown", phase: "requested" },
				state,
				observedAt: Date.parse(TIME),
				desktopSequence: 10,
				prompt: "private-prompt-content",
			}),
			record(HELPER_ID, 2, "runtime.shutdown_completed", { ignored: TOKEN }),
		]);
		await instance(OTHER_ID, 999, "runtime", [record(OTHER_ID, 1, "runtime.shutdown_completed", {})]);
		const proof = await captureDesktopShutdownEvidence(fixture, options);
		expect(proof.issues).toEqual([]);
		expect(proof.processEvidence?.phase).toBe("stopping");
		expect(proof.instances.map((value) => value.pid).sort()).toEqual([100, 101]);
		expect(proof.instances.find((value) => value.pid === 100)?.records.map((value) => value.name)).toEqual([
			"desktop.shutdown",
			"desktop.generation",
			"desktop.shutdown",
		]);
		expect(proof.instances.find((value) => value.pid === 101)?.records).toHaveLength(2);
		const artifact = await fs.readFile(join(fixture.manifest.artifactDir, "shutdown-timeout.json"), "utf8");
		expect(JSON.parse(artifact)).toEqual(proof);
		expect(artifact).not.toContain("private-");
		expect(artifact).not.toContain("diagnosticToken");
		expect(artifact).not.toContain("journalDirectory");
	});

	it("retains the bounded newest matching metadata records", async () => {
		await instance(
			MAIN_ID,
			main.pid,
			"desktop",
			Array.from({ length: 260 }, (_, index) => record(MAIN_ID, index, "desktop.recorder_closing", {})),
		);
		const proof = await captureDesktopShutdownEvidence(fixture, options);
		expect(proof.instances[0]?.records).toHaveLength(DESKTOP_SHUTDOWN_CAPTURE_LIMITS.recordsPerInstance);
		expect(proof.instances[0]?.records.at(-1)?.sequence).toBe(259);
		expect(proof.issues).toContain("limit");
		expect((await fs.stat(join(fixture.manifest.artifactDir, "shutdown-timeout.json"))).size).toBeLessThan(
			DESKTOP_SHUTDOWN_CAPTURE_LIMITS.outputBytes,
		);
	});

	it.each(["explicit", "retained"] as const)(
		"preserves an exited admitted helper selected through %s identity",
		async (selection) => {
			fixture.manifest.helperPid = null;
			await fs.writeFile(
				fixture.config.processEvidencePath,
				JSON.stringify({
					version: 1,
					appPid: main.pid,
					helperPid: helper.pid,
					phase: "failed",
					generation: MAIN_ID,
					runtimeOrigin: "http://127.0.0.1:51342",
				}),
			);
			await instance(MAIN_ID, main.pid, "desktop", [record(MAIN_ID, 1, "desktop.recorder_closing", {})]);
			await instance(HELPER_ID, helper.pid, "runtime", [record(HELPER_ID, 1, "runtime.shutdown_requested", {})]);
			const proof = await captureDesktopShutdownEvidence(fixture, {
				...options,
				helper: selection === "explicit" ? helper : null,
				retainedProcesses: [main, helper],
			});
			expect(proof.issues).toEqual([]);
			expect(proof.helper).toEqual({ pid: helper.pid, parentPid: main.pid });
			expect(proof.processEvidence?.phase).toBe("failed");
			expect(proof.instances.map((value) => value.pid).sort()).toEqual([main.pid, helper.pid]);
			expect(JSON.stringify(proof)).not.toContain("private-");
			expect(JSON.stringify(proof)).not.toContain("startedAt");
		},
	);

	it.each([
		{ field: "birth", process: { ...helper, startedAt: "2026-10-02T00:30:00.000Z" } },
		{ field: "command", process: { ...helper, command: "unadmitted-helper-command" } },
		{ field: "parent", process: { ...helper, parentPid: 999 } },
	])("rejects a historical helper whose retained $field changed", async ({ process: changedHelper }) => {
		fixture.manifest.helperPid = null;
		await instance(MAIN_ID, main.pid, "desktop", [record(MAIN_ID, 1, "desktop.recorder_closing", {})]);
		await instance(HELPER_ID, helper.pid, "runtime", [record(HELPER_ID, 1, "runtime.shutdown_requested", {})]);
		const proof = await captureDesktopShutdownEvidence(fixture, {
			...options,
			helper: null,
			retainedProcesses: [main, changedHelper],
		});
		expect(proof.helper).toBeNull();
		expect(proof.processEvidence).toBeNull();
		expect(proof.instances.map((value) => value.pid)).toEqual([main.pid]);
		expect(proof.issues).toContain("invalid");
	});

	it("rejects historical process evidence that conflicts with a current helper selection", async () => {
		fixture.manifest.helperPid = 102;
		const proof = await captureDesktopShutdownEvidence(fixture, {
			...options,
			helper: null,
			retainedProcesses: [main, helper],
		});
		expect(proof.helper).toBeNull();
		expect(proof.processEvidence).toBeNull();
		expect(proof.issues).toContain("invalid");
	});

	it("reads bounded segment tails without exporting truncated or unrelated content", async () => {
		const value = await instance(MAIN_ID, main.pid, "desktop", []);
		await fs.writeFile(
			join(value.journal, "records-000001.jsonl"),
			`${"private-secret".repeat(20_000)}\n${JSON.stringify(record(MAIN_ID, 9, "desktop.recorder_closing", {}))}\n{partial`,
		);
		const proof = await captureDesktopShutdownEvidence(fixture, options);
		expect(proof.instances[0]?.records.map((entry) => entry.sequence)).toEqual([9]);
		expect(proof.issues).toContain("limit");
		expect(JSON.stringify(proof)).not.toContain("secret");
	});

	it("writes sanitized unavailable evidence when the fixture state has already disappeared", async () => {
		await fs.rm(fixture.config.stateHome, { recursive: true });
		const proof = await captureDesktopShutdownEvidence(fixture, options);
		expect(proof.issues).toEqual(["unavailable"]);
		expect(proof.instances).toEqual([]);
		expect(
			JSON.parse(await fs.readFile(join(fixture.manifest.artifactDir, "shutdown-timeout.json"), "utf8")),
		).toEqual(proof);
	});

	it("rejects a process evidence file carrying extra fields", async () => {
		fixture.manifest.helperPid = null;
		await fs.writeFile(
			fixture.config.processEvidencePath,
			JSON.stringify({
				version: 1,
				appPid: 100,
				helperPid: 101,
				phase: "stopping",
				generation: MAIN_ID,
				runtimeOrigin: "http://127.0.0.1:51342",
				diagnosticToken: TOKEN,
			}),
		);
		const proof = await captureDesktopShutdownEvidence(fixture, {
			...options,
			helper: null,
			retainedProcesses: [main, helper],
		});
		expect(proof.processEvidence).toBeNull();
		expect(proof.issues).toContain("invalid");
		expect(JSON.stringify(proof)).not.toContain(TOKEN);
	});

	it("does not follow fixture paths or descriptor journals outside the isolated state", async () => {
		const value = await instance(MAIN_ID, main.pid, "desktop", []);
		await fs.writeFile(
			join(value.directory, "runtime.json"),
			JSON.stringify({ ...value.descriptor, journalDirectory: fixture.manifest.artifactDir }),
		);
		const proof = await captureDesktopShutdownEvidence(fixture, options);
		expect(proof.instances).toEqual([]);
		expect(proof.issues).toContain("outside_fixture");
	});

	it("rejects symbolic-link record files rather than copying the target", async () => {
		const value = await instance(MAIN_ID, main.pid, "desktop", []);
		const path = join(value.journal, "records-000001.jsonl");
		await fs.unlink(path);
		const target = join(root, "private-content");
		await fs.writeFile(target, TOKEN);
		await fs.symlink(target, path);
		const proof = await captureDesktopShutdownEvidence(fixture, options);
		expect(proof.instances[0]?.records).toEqual([]);
		expect(proof.issues).toContain("outside_fixture");
		expect(JSON.stringify(proof)).not.toContain(TOKEN);
	});

	it("refuses mismatched captured process identities and still saves fixed failure metadata", async () => {
		const proof = await captureDesktopShutdownEvidence(fixture, {
			...options,
			helper: { ...helper, parentPid: 999 },
		});
		expect(proof.issues).toContain("invalid");
		expect(proof.instances).toEqual([]);
		expect(proof.processEvidence).toBeNull();
	});

	it("returns within its own deadline when filesystem discovery stalls", async () => {
		vi.useFakeTimers();
		vi.mocked(fs.realpath).mockImplementationOnce(async () => await new Promise<never>(() => undefined));
		const pending = captureDesktopShutdownEvidence(fixture, options);
		await vi.advanceTimersByTimeAsync(DESKTOP_SHUTDOWN_CAPTURE_LIMITS.durationMs);
		expect((await pending).issues).toEqual(["deadline"]);
	});

	it.skipIf(process.platform === "win32")("rejects a FIFO without blocking its read-open", async () => {
		await fs.unlink(fixture.config.processEvidencePath);
		execFileSync("/usr/bin/mkfifo", [fixture.config.processEvidencePath]);
		const proof = await captureDesktopShutdownEvidence(fixture, options);
		expect(proof.processEvidence).toBeNull();
		expect(proof.issues).toContain("invalid");
		expect(proof.issues).not.toContain("deadline");
	});

	it("projects write failures to a fixed code and never throws to the cleanup caller", async () => {
		await fs.mkdir(join(fixture.manifest.artifactDir, "shutdown-timeout.json"));
		const proof = await captureDesktopShutdownEvidence(fixture, options);
		expect(proof.issues).toContain("write_failed");
		expect(JSON.stringify(proof)).not.toContain(root);
	});
});
