/**
 * Native, account-free macOS Pi compatibility gate. Never starts Quarterdeck.
 * Install privately (with external Node first on PATH):
 *   npm install --prefix /tmp/pi-smoke --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.2
 * Run: node --import tsx scripts/pi-compatibility-smoke.ts /tmp/pi-smoke/node_modules/@earendil-works/pi-coding-agent
 * Uses the production launch asset and native CLI events, not a mocked ExtensionAPI.
 * The local HTTP server records and acknowledges hooks; it does not test board ingestion.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type IPty, spawn as spawnPty } from "node-pty";
import { preparePiModelDiscovery } from "../src/config/pi-model-discovery.js";
import type { RuntimeHookIngestRequest } from "../src/core/api/task-session.js";
import { buildPiLifecycleExtensionSource } from "../src/terminal/pi-lifecycle-extension.js";

const EXPECTED_VERSION = "1.5.2";
const scripts = dirname(fileURLToPath(import.meta.url));
const packagePath = process.argv[2];
assert(packagePath, "Pass the absolute path to a private Pi package installation");
assert.equal(process.platform, "darwin", "This native compatibility gate currently claims macOS only");
const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, EXPECTED_VERSION, "Wrong native SDK release");
const cli = join(await realpath(packagePath), manifest.bin.pi);
const root = await realpath(await mkdtemp("/tmp/quarterdeck-pi-native-"));
const home = join(root, "home");
const agentDir = join(home, ".pi/agent");
const cwd = join(root, "task");
const fallback = join(root, "fallback");
const sessions = join(root, "sessions");
const extension = join(root, "quarterdeck-lifecycle.mjs");
const networkAudit = join(root, "network-audit.txt");
const hooks: RuntimeHookIngestRequest[] = [];
const notifications: Record<string, unknown>[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const terminals = new Map<IPty, Promise<void>>();
const assertions: string[] = [];
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => {
	assert(value && typeof value === "object" && !Array.isArray(value));
	return value as RecordValue;
};
const pass = (description: string) => {
	assertions.push(description);
	console.log(`PASS ${description}`);
};
async function until<T>(description: string, get: () => T | undefined | false, timeoutMs = 20000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = get();
		if (value !== undefined && value !== false) return value;
		await delay(20);
	}
	throw new Error(`Timed out: ${description}`);
}
async function audit(path: string): Promise<RecordValue[]> {
	if (!existsSync(path)) return [];
	return (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => object(JSON.parse(line)));
}
const recorder = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const chunk of request) {
			body += chunk;
			assert(body.length <= 1024 * 1024);
		}
		const payload = object(JSON.parse(body));
		if (request.url === "/api/trpc/hooks.ingest") {
			hooks.push(payload as unknown as RuntimeHookIngestRequest);
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ result: { data: { ok: true } } }));
		} else if (request.url?.startsWith("/api/hooks/notify?")) {
			notifications.push(payload);
			response.writeHead(204).end();
		} else response.writeHead(404).end();
	} catch {
		response.writeHead(400).end();
	}
});
await new Promise<void>((done) => recorder.listen(0, "127.0.0.1", done));
const address = recorder.address();
assert(address && typeof address !== "string");
const port = address.port;
// An allowlist, not {...process.env}: no account keys, user Pi settings,
// inherited QD identity, shell startup files, or host NODE_OPTIONS enter Pi.
const baseEnv: NodeJS.ProcessEnv = {
	PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
	HOME: home,
	USERPROFILE: home,
	TMPDIR: root,
	XDG_CONFIG_HOME: join(home, ".config"),
	XDG_CACHE_HOME: join(home, ".cache"),
	QUARTERDECK_STATE_HOME: join(root, "quarterdeck"),
	PI_CODING_AGENT_DIR: agentDir,
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
	TERM: "xterm-256color",
	COLORTERM: "truecolor",
	LANG: "en_US.UTF-8",
	NODE_OPTIONS: `--require=${JSON.stringify(join(scripts, "pi-compatibility-smoke-network.fixture.cjs"))}`,
	PI_SMOKE_HOOK_PORT: String(port),
	PI_SMOKE_NETWORK_AUDIT: networkAudit,
	QUARTERDECK_RUNTIME_HOST: "127.0.0.1",
	QUARTERDECK_RUNTIME_PORT: String(port),
	QUARTERDECK_HOOK_TASK_ID: "synthetic-task",
	QUARTERDECK_HOOK_PROJECT_ID: "synthetic-project",
	QUARTERDECK_PI_WORKTREE_TRUST_SCOPE: cwd,
	QUARTERDECK_PI_HOOK_HTTP_URL: `http://127.0.0.1:${port}/api/hooks/notify`,
	QUARTERDECK_HOOK_HTTP_TOKEN: "synthetic-recorder-only",
};
const commonArgs = [
	"--offline",
	"--no-extensions",
	"--extension",
	extension,
	"--extension",
	join(scripts, "pi-compatibility-smoke-provider.fixture.mjs"),
	"--no-mcp",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--tools",
	"read",
	"--session-dir",
	sessions,
];
function launchEnvironment(name: string, overrides: NodeJS.ProcessEnv = {}) {
	return {
		...baseEnv,
		QUARTERDECK_HOOK_SESSION_INSTANCE_ID: randomUUID(),
		PI_SMOKE_AUDIT: join(root, `${name}.jsonl`),
		...overrides,
	};
}
function launchHooks(env: NodeJS.ProcessEnv) {
	return hooks.filter((hook) => hook.metadata?.sessionInstanceId === env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID);
}
async function hook(env: NodeJS.ProcessEnv, event: string, count = 1) {
	return until(
		`native hook ${event}`,
		() => launchHooks(env).filter((entry) => entry.metadata?.hookEventName === event)[count - 1],
	);
}
function rpc(name: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
	const env = launchEnvironment(name, overrides);
	const child = spawn(process.execPath, [cli, ...commonArgs, "--mode", "rpc", ...args], { cwd, env, stdio: "pipe" });
	children.add(child);
	const records: RecordValue[] = [];
	let buffer = "";
	let stderr = "";
	let failure: Error | undefined;
	let exited = false;
	let sequence = 0;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			try {
				if (line) records.push(object(JSON.parse(line)));
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
			}
			newline = buffer.indexOf("\n");
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("error", (error) => {
		failure = error;
	});
	child.on("close", () => {
		exited = true;
		children.delete(child);
	});
	return {
		env,
		child,
		records,
		async command(type: string, fields: RecordValue = {}) {
			const id = `${name}-${++sequence}`;
			child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
			const response = await until(`${name} ${type}`, () => {
				if (failure) throw failure;
				const found = records.find((entry) => entry.type === "response" && entry.id === id);
				if (exited && !found) throw new Error(`Pi exited before ${type}: ${stderr}`);
				return found;
			});
			assert.equal(response.success, true, JSON.stringify(response));
			return response;
		},
		async stop() {
			child.stdin.end();
			await until(`${name} clean shutdown`, () => exited);
			assert.equal(child.exitCode, 0, stderr);
			assert(!records.some((entry) => entry.type === "extension_error"), JSON.stringify(records));
		},
	};
}
function terminal(name: string, args: string[], directory = cwd, overrides: NodeJS.ProcessEnv = {}) {
	const env = launchEnvironment(name, overrides);
	const terminal = spawnPty(process.execPath, [cli, ...commonArgs, "--tui-mode", "fullscreen", ...args], {
		cwd: directory,
		env: env as Record<string, string>,
		name: "xterm-256color",
		cols: 140,
		rows: 36,
	});
	let output = "";
	let exitCode: number | undefined;
	terminal.onData((data) => {
		output += data;
	});
	terminals.set(
		terminal,
		new Promise<void>((done) =>
			terminal.onExit((event) => {
				exitCode = event.exitCode;
				terminals.delete(terminal);
				done();
			}),
		),
	);
	return {
		terminal,
		env,
		output: () => output,
		exited: () => exitCode,
		async stop() {
			terminal.kill("SIGTERM");
			await until(`${name} PTY shutdown`, () => exitCode !== undefined);
			assert.equal(exitCode, 0, output);
		},
	};
}
async function runProcess(binary: string, args: string[], env: NodeJS.ProcessEnv, directory: string) {
	const child = spawn(binary, args, { cwd: directory, env, stdio: "pipe" });
	children.add(child);
	let stdout = "";
	let stderr = "";
	let exited = false;
	let error: Error | undefined;
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk;
	});
	child.once("error", (value) => {
		error = value;
	});
	child.once("close", () => {
		exited = true;
		children.delete(child);
	});
	child.stdin.end();
	await until("bounded native subprocess", () => {
		if (error) throw error;
		assert(stdout.length + stderr.length < 4 * 1024 * 1024, "Native subprocess output exceeded cap");
		return exited;
	});
	return { stdout, stderr, code: child.exitCode };
}
async function snapshot(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...(await snapshot(path)));
		else {
			const info = await stat(path, { bigint: true });
			result.push(
				JSON.stringify([
					path,
					String(info.mtimeNs),
					String(info.ctimeNs),
					createHash("sha256")
						.update(await readFile(path))
						.digest("hex"),
				]),
			);
		}
	}
	return result.sort();
}
try {
	for (const directory of [agentDir, cwd, fallback, sessions, join(cwd, ".pi")])
		await mkdir(directory, { recursive: true });
	await writeFile(extension, buildPiLifecycleExtensionSource());
	await writeFile(networkAudit, "");
	await writeFile(join(cwd, "fixture.txt"), "Synthetic local tool evidence\n");
	await writeFile(join(cwd, ".pi/settings.json"), "{}\n");
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "quarterdeck-smoke",
			defaultModel: "local",
			defaultProjectTrust: "never",
			retry: { enabled: false },
			compaction: { enabled: false },
			cacheWarming: "off",
			quietStartup: true,
			theme: "dark",
			tuiMode: "regular",
			enableInstallTelemetry: false,
		}),
	);
	const version = await runProcess(process.execPath, [cli, "--version"], baseEnv, cwd);
	assert.equal(version.code, 0);
	assert.equal(version.stdout.trim(), EXPECTED_VERSION);
	pass(`private SDK manifest and native CLI are exactly ${EXPECTED_VERSION}`);

	const fresh = rpc("fresh");
	const initial = object((await fresh.command("get_state")).data);
	const sessionId = String(initial.sessionId);
	const sessionFile = String(initial.sessionFile);
	const meta = await hook(fresh.env, "session_meta");
	assert.equal(meta.metadata?.sessionId, sessionId);
	const startAudit = await audit(String(fresh.env.PI_SMOKE_AUDIT));
	assert.equal(startAudit.find((entry) => entry.type === "session_start")?.trusted, true);
	assert(!existsSync(join(agentDir, "trust.json")));
	pass("native project_trust grants exact scope despite default never, without saving trust");

	const beforeConsume = launchHooks(fresh.env).length;
	const consumed = await fresh.command("prompt", { message: "smoke:consume" });
	assert.equal(object(consumed.data).disposition, "handled");
	await fresh.command("get_state");
	assert.equal(launchHooks(fresh.env).length, beforeConsume);
	assert(!fresh.records.some((entry) => entry.type === "agent_start"));
	pass("native consumed input starts no agent run or working hook");

	await fresh.command("prompt", { message: "smoke:tool" });
	const settled = await hook(fresh.env, "AgentSettled");
	const work = await hook(fresh.env, "AgentStart");
	const ended = await hook(fresh.env, "AgentEnd");
	assert.equal(work.event, "to_in_progress");
	assert.equal(ended.event, "activity");
	assert.equal(settled.event, "to_review");
	assert.equal(settled.metadata?.turnId, work.metadata?.turnId);
	assert.equal(ended.metadata?.turnId, work.metadata?.turnId);
	assert.equal(settled.metadata?.finalMessage, "Synthetic reply\n\n  preserved indentation");
	assert(fresh.records.some((entry) => entry.type === "tool_execution_end" && entry.isError === false));
	await until("best-effort native tool activity", () =>
		notifications.some((entry) => entry.hook_event_name === "ToolExecutionStart"),
	);
	assert(launchHooks(fresh.env).indexOf(ended) < launchHooks(fresh.env).indexOf(settled));
	pass("native tool execution, run identity, AgentEnd activity, final settlement and Markdown reply");

	await fresh.command("prompt", { message: "smoke:hold" });
	await hook(fresh.env, "AgentStart", 2);
	await fresh.command("abort");
	const interrupted = await hook(fresh.env, "Interrupt");
	assert.equal(interrupted.event, "to_review");
	assert(!interrupted.metadata?.finalMessage);
	assert(fresh.records.some((entry) => entry.type === "agent_settled" && entry.aborted === true));
	pass("native cancellation settles aborted and emits Interrupt without a reply");

	await fresh.command("prompt", { message: "smoke:error" });
	const failed = await hook(fresh.env, "StopFailure");
	assert.equal(failed.event, "to_review");
	assert(!failed.metadata?.finalMessage);
	pass("native terminal assistant failure emits StopFailure without a reply");

	const messages = object((await fresh.command("get_fork_messages")).data).messages;
	assert(Array.isArray(messages) && messages.length > 0);
	for (const [type, fields] of [
		["new_session", {}],
		["switch_session", { sessionPath: sessionFile }],
		["fork", { entryId: object(messages[0]).entryId }],
		["clone", {}],
	] as const)
		assert.equal(object((await fresh.command(type, fields)).data).cancelled, true);
	assert.equal(object((await fresh.command("get_state")).data).sessionId, sessionId);
	await fresh.stop();
	assert((await audit(String(fresh.env.PI_SMOKE_AUDIT))).some((entry) => entry.type === "session_shutdown"));
	pass("native new/resume/fork/clone are vetoed; orderly stop dispatches session_shutdown");

	for (const name of ["resume", "cold-resume"]) {
		const resumed = rpc(name, ["--session", sessionId]);
		assert.equal(object((await resumed.command("get_state")).data).sessionId, sessionId);
		const resumedMeta = await hook(resumed.env, "session_meta");
		assert.equal(resumedMeta.metadata?.sessionId, sessionId);
		assert.equal(launchHooks(resumed.env).length, 1, "Resume alone must remain metadata-only");
		await resumed.command("prompt", { message: "smoke:resumed" });
		await hook(resumed.env, "AgentSettled");
		await resumed.stop();
	}
	pass("two fresh native processes resume the exact saved ID, without replaying the initial prompt");

	for (const [name, overrides] of [
		["wrong-trust-scope", { QUARTERDECK_PI_WORKTREE_TRUST_SCOPE: root }],
		["explicit-no-approve", {}],
	] as const) {
		const untrusted = rpc(name, name === "explicit-no-approve" ? ["--no-approve"] : [], overrides);
		await untrusted.command("get_state");
		assert.equal(
			(await audit(String(untrusted.env.PI_SMOKE_AUDIT))).find((entry) => entry.type === "session_start")?.trusted,
			false,
		);
		await untrusted.stop();
	}
	assert(!existsSync(join(agentDir, "trust.json")));
	pass("parent-scope mismatch cannot grant trust; explicit --no-approve retains precedence");

	const fullscreen = terminal("fullscreen", ["smoke:fullscreen"]);
	await hook(fullscreen.env, "AgentSettled");
	assert(
		fullscreen.output().includes("\x1b[?1049h"),
		"Native CLI must enter alternate-screen fullscreen despite regular saved setting",
	);
	await fullscreen.stop();
	pass("actual native PTY accepts --tui-mode fullscreen and enters alternate screen");

	// The saved header still names task/, but the fallback launch directory exists.
	// Use the exact saved file here: UUID lookup from a different cwd has an
	// earlier cross-project fork-confirmation prompt, before missing-cwd handling.
	await rm(cwd, { recursive: true, force: true });
	const missing = await runProcess(
		process.execPath,
		[cli, ...commonArgs, "--mode", "rpc", "--session", sessionFile],
		launchEnvironment("missing-rpc"),
		fallback,
	);
	assert.notEqual(missing.code, 0);
	assert.match(missing.stderr, /Stored session working directory does not exist/);
	pass("noninteractive saved-path resume fails explicitly for a missing saved working folder");

	for (const choice of ["continue", "fork", "cancel"] as const) {
		const selected = terminal(`missing-${choice}`, ["--session", sessionFile], fallback);
		await until(`missing-folder ${choice} selector`, () => selected.output().includes("Fork into"));
		if (choice === "cancel") {
			selected.terminal.write("\x1b");
			await until("cancel exits startup", () => selected.exited() !== undefined);
			assert.equal(selected.exited(), 0);
			assert.equal(launchHooks(selected.env).length, 0);
		} else {
			selected.terminal.write(choice === "fork" ? "\x1b[B\r" : "\r");
			const firstHook = await hook(selected.env, "session_meta");
			if (choice === "continue") assert.equal(firstHook.metadata?.sessionId, sessionId);
			else assert.notEqual(firstHook.metadata?.sessionId, sessionId);
			assert.equal(
				(await audit(String(selected.env.PI_SMOKE_AUDIT))).find((entry) => entry.type === "session_start")?.cwd,
				fallback,
			);
			await selected.stop();
		}
		pass(
			`native missing-folder ${choice}: ${choice === "fork" ? "first hook has a NEW ID (runtime must reject expected-ID mismatch)" : choice === "continue" ? "original ID, fallback cwd" : "no extension/session hook"}`,
		);
	}
	// Native SDK discovery must not initialize resources, sessions, or auth writes.
	const discoverySettings = object(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")));
	discoverySettings.enabledModels = ["quarterdeck-discovery/second", "quarterdeck-discovery/first"];
	discoverySettings.extensions = [join(root, "must-not-load.mjs")];
	await writeFile(join(root, "must-not-load.mjs"), "throw new Error('Discovery executed an extension');\n");
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(discoverySettings));
	const model = (id: string) => ({
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	});
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"quarterdeck-discovery": {
					baseUrl: "http://synthetic.invalid",
					api: "openai-completions",
					apiKey: "synthetic-not-a-credential",
					models: [model("first"), model("second")],
				},
			},
		}),
	);
	const beforeDiscovery = await Promise.all([home, fallback, sessions].map(snapshot));
	const discovery = await preparePiModelDiscovery(cli, fallback);
	const discovered = await runProcess(discovery.binary, discovery.args, baseEnv, fallback);
	assert.equal(discovered.code, 0, discovered.stderr);
	assert.deepEqual(JSON.parse(discovered.stdout), {
		models: [
			{ provider: "quarterdeck-discovery", id: "second" },
			{ provider: "quarterdeck-discovery", id: "first" },
		],
	});
	assert.deepEqual(await Promise.all([home, fallback, sessions].map(snapshot)), beforeDiscovery);
	pass(
		"production offline model discovery uses the installed 1.5.2 SDK, preserves scope order, executes no extensions, and writes nothing",
	);

	assert.equal(await readFile(networkAudit, "utf8"), "", "Unexpected Node network attempt occurred");
	assert(hooks.every((entry) => entry.metadata?.source === "pi" && entry.delivery?.id));
	pass("all durable hooks came from native Pi with delivery IDs; no unexpected network attempts");
} finally {
	const terminalExits = [...terminals.values()];
	for (const terminal of terminals.keys()) terminal.kill("SIGKILL");
	const childExits = [...children].map((child) => new Promise<void>((done) => child.once("close", () => done())));
	for (const child of children) child.kill("SIGKILL");
	let cleaned = false;
	void Promise.all([...terminalExits, ...childExits]).then(() => {
		cleaned = true;
	});
	await until("owned subprocess cleanup", () => cleaned, 5000);
	recorder.closeAllConnections();
	await new Promise<void>((done) => recorder.close(() => done()));
	await rm(root, { recursive: true, force: true });
}
console.log(
	JSON.stringify(
		{
			version: EXPECTED_VERSION,
			node: process.execPath,
			platform: process.platform,
			assertions,
			gaps: [
				"No authenticated provider",
				"No Quarterdeck board ingest/admission or UI recovery proof",
				"No optional third-party subagent integrations",
				"Missing-folder choices use the saved file; cross-project UUID lookup has an earlier native fork-confirmation prompt",
				"Network guard is Node-level defense in depth, not an OS sandbox",
			],
			cleanup:
				"All child processes, recorder, and disposable state removed; supplied private package installation retained",
		},
		null,
		2,
	),
);
