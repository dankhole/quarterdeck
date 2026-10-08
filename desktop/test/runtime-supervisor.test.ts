import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../../src/core/api/runtime-protocol.js";
import { RuntimeSupervisor, type RuntimeSupervisorEvidence } from "../src/runtime-supervisor.js";

const children: ChildProcess[] = [];
afterEach(async () => {
	await Promise.all(
		children.splice(0).map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			if (child.connected) child.disconnect();
			await exited;
		}),
	);
});

function supervisor(
	mode = "normal",
	throwObserver = false,
): {
	owner: RuntimeSupervisor;
	evidence: RuntimeSupervisorEvidence[];
	unexpected: Promise<void>;
} {
	const evidence: RuntimeSupervisorEvidence[] = [];
	let notifyUnexpected: () => void = () => undefined;
	const unexpected = new Promise<void>((resolve) => {
		notifyUnexpected = resolve;
	});
	const owner = new RuntimeSupervisor({
		bundle: {
			root: "/synthetic",
			nodePath: "/synthetic/bin/node",
			cliPath: "/synthetic/dist/cli.js",
			version: "0.12.8",
			buildId: "synthetic",
			sourceSha: "a".repeat(40),
			arch: process.arch,
		},
		launch: {
			synthetic: true,
			stateHome: "/synthetic/state",
			projectPath: "/synthetic/project",
			hostSimulationConfigPath: "/synthetic/host.json",
		},
		environment: {
			...process.env,
			DESKTOP_FIXTURE_MODE: mode,
			DESKTOP_FIXTURE_BROWSER_PROTOCOL: String(QUARTERDECK_RUNTIME_PROTOCOL_VERSION),
		},
		startupDeadlineMs: 500,
		shutdownDeadlineMs: 1000,
		spawnChild: (executable, args, options) => {
			expect(executable).toBe("/synthetic/bin/node");
			if (args[1] === "recover") {
				expect(mode).toBe("maintenance");
				expect(args).toEqual(["/synthetic/dist/cli.js", "recover", "--confirm-stopped"]);
				expect(options.env?.QUARTERDECK_DESKTOP_CHILD).toBeUndefined();
				const child = spawn(
					process.execPath,
					[fileURLToPath(new URL("./fixtures/recovery-helper.mjs", import.meta.url))],
					{ ...options, cwd: undefined },
				);
				children.push(child);
				return child;
			}
			expect(args).toContain("--no-open");
			expect(args).toContain("--no-native-ui");
			expect(args).not.toContainEqual(expect.stringContaining("clientToken"));
			expect(options.env?.QUARTERDECK_STATE_HOME).toBe("/synthetic/state");
			expect(options.env?.QUARTERDECK_DESKTOP_CHILD).toBe("1");
			const child = spawn(
				mode === "spawn-failure" ? "/nonexistent/quarterdeck-desktop-test-node" : process.execPath,
				[fileURLToPath(new URL("./fixtures/runtime-helper.mjs", import.meta.url))],
				{ ...options, cwd: undefined },
			);
			children.push(child);
			return child;
		},
		onEvidence: (value) => {
			evidence.push(value);
			if (throwObserver) throw new Error("Synthetic observer failure.");
		},
		onUnexpectedExit: notifyUnexpected,
	});
	return { owner, evidence, unexpected };
}

describe("private bundled runtime supervision", () => {
	it("fences runtime start until the maintenance helper actually exits", async () => {
		const { owner } = supervisor("maintenance");
		const recovery = owner.recoverPriorSessions();
		expect(owner.isRecoveryRunning()).toBe(true);
		await expect(owner.start()).rejects.toThrow("recovery check is still running");
		expect(await recovery).toBe("recovered");
		expect(owner.isRecoveryRunning()).toBe(false);
		await owner.start();
		expect(await owner.stop()).toMatchObject({ status: "clean" });
	});
	it("preserves lifecycle ownership when an evidence observer throws", async () => {
		const { owner } = supervisor("normal", true);
		await owner.start();
		expect(await owner.stop()).toMatchObject({ status: "clean" });
		expect(owner.isRunning()).toBe(false);
	});
	it("uses private IPC readiness and requires confirmed quiescence plus process exit", async () => {
		const { owner, evidence } = supervisor();
		const ready = await owner.start();
		expect(await owner.recoverPriorSessions()).toBe("unavailable");
		expect(ready.origin).toBe("http://127.0.0.1:12345");
		expect(ready.clientToken).toMatch(/^[a-zA-Z0-9_-]{43}$/);
		expect(JSON.stringify(evidence)).not.toContain(ready.clientToken);
		await expect(owner.start()).rejects.toThrow("already running");
		expect(await owner.stop()).toEqual({ status: "clean", safeToExit: true, safeToReleaseOwnership: true });
		expect(owner.isRunning()).toBe(false);
		expect(owner.exitCleanupState()).toBe("clean");
		expect(evidence.map((value) => value.phase)).toEqual(["starting", "ready", "stopping", "stopped"]);
	});

	it("does not equate a zero exit code with a successful shutdown", async () => {
		const { owner } = supervisor("no-ack");
		await owner.start();
		expect(await owner.stop()).toMatchObject({
			status: "incomplete",
			safeToExit: false,
			reasons: ["processes_unconfirmed"],
		});
	});

	it("keeps a failed quiescence report actionable without pretending the helper stopped", async () => {
		const { owner } = supervisor("incomplete");
		await owner.start();
		expect(await owner.stop()).toMatchObject({ status: "incomplete", reasons: ["persistence_failed"] });
		expect(owner.isRunning()).toBe(true);
	});

	it("rejects readiness from another launch and shuts down its actual helper", async () => {
		const { owner, evidence } = supervisor("wrong-startup");
		await expect(owner.start()).rejects.toThrow("could not become ready");
		expect(owner.isRunning()).toBe(false);
		expect(evidence.some((item) => item.phase === "ready")).toBe(false);
	});

	it("reports unexpected helper loss once after readiness", async () => {
		const { owner, unexpected } = supervisor("unexpected-exit");
		await owner.start();
		await unexpected;
		expect(owner.isRunning()).toBe(false);
		expect(await owner.stop()).toMatchObject({ status: "incomplete", reasons: ["processes_unconfirmed"] });
		expect(owner.exitCleanupState()).toBe("unconfirmed");
	});
	it("accepts only matching private control replies and bounds unavailable controls", async () => {
		const { owner } = supervisor();
		expect(await owner.control("get-quit-summary")).toBeNull();
		await owner.start();
		expect(await owner.control("get-quit-summary")).toEqual({
			method: "get-quit-summary",
			owned: true,
			liveProcessCount: 2,
			pendingLaunches: false,
		});
		expect(await owner.control("create-browser-launch")).toMatchObject({ method: "create-browser-launch" });
		await owner.stop();
		expect(await owner.control("get-quit-summary")).toBeNull();
		const timeout = supervisor("control-timeout").owner;
		await timeout.start();
		expect(await timeout.control("get-quit-summary", 20)).toBeNull();
		await timeout.stop();
	});
	it("preserves only the typed content-safe startup failure class", async () => {
		const { owner } = supervisor("ownership-failure");
		await expect(owner.start()).rejects.toMatchObject({ code: "recovery_custody_unconfirmed" });
	});

	it("allows safe Quit after a child spawn failed without ever creating a process", async () => {
		const { owner } = supervisor("spawn-failure");
		await expect(owner.start()).rejects.toThrow();
		expect(await owner.stop()).toMatchObject({ status: "clean", safeToExit: true });
	});

	it("does not claim shutdown authority over an attached CLI owner when its relay exits", async () => {
		const { owner, unexpected } = supervisor("attached-exit");
		await owner.start();
		await unexpected;
		expect(await owner.stop()).toMatchObject({ status: "clean", safeToExit: true });
	});
});
