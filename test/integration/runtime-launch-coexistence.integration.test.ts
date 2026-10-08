import { type ChildProcess, execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DesktopReadyMessage, desktopChildMessageSchema } from "../../src/core/api/desktop-runtime-protocol.js";
import {
	acquireRuntimeOwnership,
	discoverRuntimeOwner,
	type RuntimeOwnershipLease,
} from "../../src/server/runtime-ownership.js";
import { initGitRepository } from "../utilities/git-env.js";
import {
	getAvailablePort,
	resolveIntegrationEntrypoint,
	resolveIntegrationNodeArgs,
	startQuarterdeckServer,
	waitForExit,
} from "../utilities/integration-server.js";

const execute = promisify(execFile);

describe("actual CLI and desktop relay coexistence", () => {
	let directory: string;
	let stateHome: string;
	let projectPath: string;
	const children: ChildProcess[] = [];
	let server: Awaited<ReturnType<typeof startQuarterdeckServer>> | null;
	let lease: RuntimeOwnershipLease | null;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-coexistence-"));
		stateHome = join(directory, "state");
		projectPath = join(directory, "project");
		await mkdir(projectPath);
		initGitRepository(projectPath);
		server = null;
		lease = null;
	});
	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.connected) child.disconnect();
			if (!(await waitForExit(child, 5_000))) {
				child.kill("SIGKILL");
				await waitForExit(child, 5_000);
			}
		}
		await server?.stop();
		await lease?.release();
		await rm(directory, { recursive: true, force: true });
	});

	async function invoke(...args: string[]) {
		return await execute(process.execPath, [...resolveIntegrationNodeArgs(), "--no-open", ...args], {
			cwd: projectPath,
			env: { ...process.env, HOME: directory, USERPROFILE: directory, QUARTERDECK_STATE_HOME: stateHome },
			timeout: 20_000,
		});
	}

	async function launchDesktopRelay() {
		const startupId = randomUUID();
		const entrypoint = resolveIntegrationEntrypoint();
		const child = fork(entrypoint.path, ["--no-open", "--port", "auto"], {
			execArgv: entrypoint.execArgv,
			cwd: projectPath,
			env: {
				...process.env,
				HOME: directory,
				USERPROFILE: directory,
				QUARTERDECK_STATE_HOME: stateHome,
				QUARTERDECK_DESKTOP_CHILD: "1",
			},
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		child.stdout?.resume();
		child.stderr?.resume();
		const ready = new Promise<DesktopReadyMessage>((done, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`Desktop relay exited before ready (${code}).`)));
			child.once("message", (value: unknown) => {
				const parsed = desktopChildMessageSchema.parse(value);
				if (parsed.type === "quarterdeck:desktop-ready") done(parsed);
				else reject(new Error("Desktop relay rejected startup."));
			});
		});
		child.send({
			type: "quarterdeck:desktop-startup",
			protocolVersion: 1,
			startupId,
			clientToken: "b".repeat(43),
			allowedOrigins: ["app://quarterdeck"],
		});
		return { child, startupId, ready: await ready };
	}

	it("attaches a second CLI and desktop relay to the same owner without starting another runtime", async () => {
		server = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: directory,
			port: await getAvailablePort(),
			extraEnv: { QUARTERDECK_STATE_HOME: stateHome },
		});
		const original = await discoverRuntimeOwner(stateHome);
		const beforeInstances = await readdir(join(stateHome, "diagnostics", "instances"));
		const other = await invoke("--port", String(await getAvailablePort()));
		expect(other.stdout.includes("Quarterdeck already running at")).toBe(true);
		const relay = await launchDesktopRelay();
		expect(relay.ready.ownership).toBe("attached");
		expect(relay.ready.diagnosticInstanceId).toBeNull();
		expect(relay.ready.runtimeGeneration).toBe(original?.claim.generation);
		expect(relay.ready.runtimeOrigin).toBe(new URL(server.runtimeUrl).origin);
		const shutdown = new Promise<unknown>((done) => relay.child.once("message", done));
		relay.child.send({
			type: "quarterdeck:desktop-shutdown",
			protocolVersion: 1,
			startupId: relay.startupId,
			requestId: randomUUID(),
		});
		expect(await shutdown).toMatchObject({
			type: "quarterdeck:desktop-shutdown-result",
			outcome: { status: "clean" },
		});
		expect(await waitForExit(relay.child, 5_000)).toBe(true);
		expect(relay.child.exitCode).toBe(0);
		expect((await discoverRuntimeOwner(stateHome))?.claim.generation).toBe(original?.claim.generation);
		expect((await discoverRuntimeOwner(stateHome))?.processState).toBe("live");
		expect(await readdir(join(stateHome, "diagnostics", "instances"))).toEqual(beforeInstances);
		const response = await fetch(`${new URL(server.runtimeUrl).origin}/api/trpc/projects.list`, {
			headers: server.browserHeaders,
		});
		expect(response.status).toBe(200);
	});

	it("refuses an incompatible live owner before runtime startup cleanup", async () => {
		const admission = await acquireRuntimeOwnership({
			stateHome,
			quarterdeckVersion: "legacy-test",
			runtimeProtocolVersion: 1,
		});
		if (admission.kind !== "acquired") throw new Error("Expected isolated ownership.");
		lease = admission.lease;
		await lease.markReady({ host: "127.0.0.1", port: await getAvailablePort() });
		const marker = join(stateHome, "sentinel.lock");
		await writeFile(marker, "preserve");
		await expect(invoke()).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("compatible Quarterdeck version"),
		});
		expect(await readFile(marker, "utf8")).toBe("preserve");
		await expect(readdir(join(stateHome, "diagnostics"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps the live owner's simulation ledger intact when an attached CLI requests auto-open", async () => {
		const ledgerPath = join(directory, "host-events.json");
		const configPath = join(directory, "host-simulation.json");
		await writeFile(
			configPath,
			JSON.stringify({
				schemaVersion: 1,
				ledgerPath,
				pathScopes: [{ id: "primary_project", rootPath: projectPath }],
			}),
		);
		server = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: directory,
			port: await getAvailablePort(),
			extraArgs: ["--no-native-ui", "--simulate-host-integrations", configPath],
			extraEnv: { QUARTERDECK_STATE_HOME: stateHome },
		});
		const original = await discoverRuntimeOwner(stateHome);
		expect(original?.processState).toBe("live");
		const beforeInstances = await readdir(join(stateHome, "diagnostics", "instances"));
		const hostEventsUrl = `${new URL(server.runtimeUrl).origin}/api/agent-lab/host-events`;
		const seeded = await fetch(hostEventsUrl, {
			method: "POST",
			headers: { ...server.browserHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "clipboard_write", characterCount: 7 }),
			signal: AbortSignal.timeout(3_000),
		});
		expect(seeded.status).toBe(201);
		await seeded.arrayBuffer();
		const beforeLedger = await readFile(ledgerPath);
		// Deliberately omit invoke()'s --no-open: exercise the actual auto-open
		// branch without permitting any native host effect.
		const attached = await execute(
			process.execPath,
			[...resolveIntegrationNodeArgs(), "--no-native-ui", "--simulate-host-integrations", configPath],
			{
				cwd: projectPath,
				env: { ...process.env, HOME: directory, USERPROFILE: directory, QUARTERDECK_STATE_HOME: stateHome },
				timeout: 20_000,
			},
		).catch(() => {
			throw new Error("Attached simulated CLI failed; browser capability output withheld.");
		});
		// Boolean assertions keep the one-use browser capability out of failures.
		expect(attached.stdout.includes("Quarterdeck already running at")).toBe(true);
		expect(
			attached.stderr.includes(
				"Simulated browser launch is unavailable while attaching; use the Browser URL below.",
			),
		).toBe(true);
		expect(attached.stdout.includes(`Browser URL: ${new URL(server.runtimeUrl).origin}/`)).toBe(true);
		expect(attached.stdout.includes("Browser launcher accepted")).toBe(false);
		expect((await readFile(ledgerPath)).equals(beforeLedger)).toBe(true);
		const after = await discoverRuntimeOwner(stateHome);
		expect(after?.claim).toEqual(original?.claim);
		expect(after?.processState).toBe("live");
		expect(await readdir(join(stateHome, "diagnostics", "instances"))).toEqual(beforeInstances);
		const liveLedger = await fetch(hostEventsUrl, {
			headers: server.browserHeaders,
			signal: AbortSignal.timeout(3_000),
		});
		expect(liveLedger.status).toBe(200);
		expect(await liveLedger.json()).toMatchObject({
			lastSequence: 1,
			events: [{ kind: "clipboard_write", sequence: 1, characterCount: 7 }],
		});
		expect((await readFile(ledgerPath)).equals(beforeLedger)).toBe(true);
	});

	it("refuses a live legacy descriptor before touching existing state", async () => {
		const instance = join(stateHome, "diagnostics", "instances", "legacy");
		await mkdir(instance, { recursive: true });
		await writeFile(join(instance, "runtime.json"), JSON.stringify({ pid: process.pid, status: "ready" }));
		const marker = join(stateHome, "sentinel.lock");
		await writeFile(marker, "preserve");
		await expect(invoke()).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("without current ownership admission"),
		});
		expect(await readFile(marker, "utf8")).toBe("preserve");
		expect(await readdir(join(stateHome, "diagnostics", "instances"))).toEqual(["legacy"]);
	});
});
