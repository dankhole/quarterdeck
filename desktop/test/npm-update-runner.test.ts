import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DesktopInstallation } from "../../src/desktop-install/index.js";
import {
	NpmUpdatePreparationError,
	type NpmUpdatePreparationServices,
	type PreparedNpmUpdate,
	prepareNpmUpdate,
} from "../src/npm-update-runner.js";
import {
	cleanupNpmUpdateDirectory,
	identifyUpdateFile,
	NpmUpdateChannel,
	npmUpdateArguments,
	npmUpdateRequestSchema,
	npmUpdateRetryCommand,
	updateEnvironment,
} from "../src/npm-update-worker.js";

let suite: string;
let workerPath: string;
const fixtures: string[] = [];
const children: ChildProcess[] = [];
const prepared: PreparedNpmUpdate[] = [];
const rawServers: Server[] = [];

beforeAll(async () => {
	suite = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "qd-ut-")));
	workerPath = join(suite, "standalone-worker.mjs");
	await build({
		entryPoints: [fileURLToPath(new URL("../src/npm-update-worker-entry.ts", import.meta.url))],
		outfile: workerPath,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		logLevel: "silent",
	});
});
afterAll(async () => {
	await rm(suite, { recursive: true, force: true });
});
afterEach(async () => {
	await Promise.all(prepared.splice(0).map((handoff) => handoff.cancel().catch(() => {})));
	await Promise.all(children.splice(0).map(stop));
	await Promise.all(
		rawServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function fixture(mode = "success", overrides: NodeJS.ProcessEnv = {}) {
	const root = await realpath(await mkdtemp(join(suite, "c'$-")));
	fixtures.push(root);
	const prefix = join(root, "Node's $(unused) `literal` prefix");
	const packageRoot = join(prefix, "lib/node_modules/quarterdeck");
	const appPath = join(root, "Applications/Quarterdeck.app");
	const receiptPath = join(root, "managed/managed-installation.json");
	const npmRoot = join(prefix, "lib/node_modules/npm");
	const bin = join(prefix, "bin");
	await Promise.all([
		mkdir(join(packageRoot, "dist"), { recursive: true }),
		mkdir(appPath, { recursive: true }),
		mkdir(dirname(receiptPath), { recursive: true }),
		mkdir(join(npmRoot, "bin"), { recursive: true }),
		mkdir(bin, { recursive: true }),
	]);
	const installation: DesktopInstallation = {
		appPath,
		receiptPath,
		version: "1.0.0",
		arch: process.arch === "arm64" ? "arm64" : "x64",
		source: "release",
		installId: randomUUID(),
		buildId: randomUUID(),
		appAsarSha256: "a".repeat(64),
		cleanupPending: false,
		owner: {
			kind: "npm",
			prefix,
			packageRoot,
			packageSlot: packageRoot,
			identity: {
				schemaVersion: 1,
				version: "1.0.0",
				buildId: randomUUID(),
				sourceSha: "b".repeat(40),
				sourceDirty: false,
			},
		},
	};
	const receipt = {
		schemaVersion: 2,
		managedBy: "quarterdeck-npm",
		installId: installation.installId,
		version: installation.version,
		arch: installation.arch,
		source: installation.source,
		appPath,
		bundleId: "io.github.dankhole.quarterdeck",
		buildId: installation.buildId,
		appAsarSha256: installation.appAsarSha256,
		appTreeSha256: "c".repeat(64),
		desktopLaunchProtocolVersion: 1,
		updatesEnabled: false,
		owner: installation.owner,
		signing: { verified: true, teamId: "ABCDEFGHIJ" },
		release: {
			manifestSha256: "d".repeat(64),
			containerName: "synthetic.dmg",
			containerSha256: "e".repeat(64),
			sourceSha: "b".repeat(40),
		},
	};
	const updated = {
		...installation,
		version: "1.1.0",
		owner: {
			...installation.owner,
			identity: { ...installation.owner.identity, version: "1.1.0", buildId: randomUUID() },
		},
	};
	await Promise.all([
		writeFile(receiptPath, JSON.stringify(receipt)),
		writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "quarterdeck", version: "1.0.0" })),
		writeFile(join(packageRoot, "dist/build-manifest.json"), JSON.stringify(installation.owner.identity)),
		writeFile(
			join(packageRoot, "dist/cli.js"),
			'import {readFileSync} from "node:fs"; if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["desktop","status","--json"])) process.exit(8); await new Promise(resolve => setTimeout(resolve, Number(process.env.TEST_STATUS_DELAY_MS ?? 0))); console.log(readFileSync(process.env.TEST_STATUS, "utf8"));',
		),
		writeFile(join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "11.19.1", type: "module" })),
		writeFile(join(root, "status.json"), JSON.stringify({ state: "ready", pending: false, installation: updated })),
	]);
	await writeFile(
		join(npmRoot, "bin/npm-cli.js"),
		`#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
if (process.argv[2] === '--version') { console.log('11.19.1'); process.exit(0); }
writeFileSync(process.env.TEST_TRACE, JSON.stringify({args:process.argv.slice(2),PATH:process.env.PATH,installMode:process.env.QUARTERDECK_INSTALL_MODE,ignoreScripts:process.env.npm_config_ignore_scripts,lockFd:process.env.QUARTERDECK_INSTALLATION_LOCK_FD,nodeOptions:process.env.NODE_OPTIONS,secret:process.env.TEST_SECRET}));
console.log('synthetic npm lifecycle output');
if (process.env.TEST_MODE === 'failure') process.exit(17);
const result=JSON.parse(readFileSync(process.env.TEST_STATUS,'utf8'));
if (process.env.TEST_MODE === 'mismatch' || process.env.npm_config_ignore_scripts === 'true') result.installation.version='1.0.0';
if (process.env.TEST_MODE === 'owner') result.installation.owner.prefix+='/other';
if (process.env.TEST_MODE === 'pending') result.pending=true;
writeFileSync(process.env.TEST_STATUS,JSON.stringify(result));
`,
	);
	await chmod(join(npmRoot, "bin/npm-cli.js"), 0o700);
	await symlink(join(npmRoot, "bin/npm-cli.js"), join(bin, "npm"));
	const node = await realpath(process.execPath);
	const parent = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { PATH: dirname(node) } });
	children.push(parent);
	if (!parent.pid) throw new Error("Synthetic parent did not start.");
	let worker: ChildProcess | undefined;
	let output = "";
	let handoffDirectory = "";
	const environment: NodeJS.ProcessEnv = {
		HOME: root,
		USERPROFILE: root,
		PATH: `${bin}:${appPath}/Contents/Resources/runtime/bin:${packageRoot}/bin:${dirname(node)}:/usr/bin:/bin`,
		TEST_TRACE: join(root, "trace.json"),
		TEST_STATUS: join(root, "status.json"),
		TEST_MODE: mode,
		TEST_SECRET: "synthetic-in-memory-only",
		QUARTERDECK_INSTALLATION_LOCK_FD: "99",
		QUARTERDECK_INSTALLATION_LOCK_PATH: "/synthetic/lock",
		QUARTERDECK_INSTALL_MODE: "browser",
		NODE_OPTIONS: "--require /synthetic/injection.js",
		...overrides,
	};
	const prepare = async (services: NpmUpdatePreparationServices = {}) => {
		const handoff = await prepareNpmUpdate(
			{ installation, targetVersion: "1.1.0", environment, parentPid: parent.pid },
			{
				workerPath,
				temporaryRoot: root,
				readinessTimeoutMs: 5_000,
				authorizationTimeoutMs: 5_000,
				parentExitTimeoutMs: 1_000,
				async launchTerminal(commandPath, nodePath, privateWorker, directory) {
					handoffDirectory = directory;
					const script = await readFile(commandPath, "utf8");
					expect(script).toContain("exec /usr/bin/env -i");
					expect(script).toContain(nodePath);
					expect(script).not.toContain("synthetic-in-memory-only");
					expect(await readFile(join(directory, "request.json"), "utf8")).not.toContain(
						"synthetic-in-memory-only",
					);
					expect(privateWorker.startsWith(root)).toBe(true);
					worker = spawn("/bin/sh", [commandPath], {
						stdio: ["ignore", "pipe", "pipe"],
						env: { PATH: "/usr/bin:/bin" },
						cwd: "/",
					});
					children.push(worker);
					worker.stdout?.on("data", (bytes: Buffer) => {
						output += bytes.toString();
					});
					worker.stderr?.on("data", (bytes: Buffer) => {
						output += bytes.toString();
					});
				},
				...services,
			},
		);
		prepared.push(handoff);
		return handoff;
	};
	const finished = async () => {
		if (!worker) throw new Error("No synthetic worker was launched.");
		const code =
			worker.exitCode ??
			(await new Promise<number | null>((resolve) => worker?.once("exit", (code) => resolve(code))));
		return { code, output };
	};
	return {
		root,
		installation,
		receipt,
		parent,
		environment,
		prepare,
		finished,
		output: () => output,
		directory: () => handoffDirectory,
		tracePath: join(root, "trace.json"),
	};
}

async function rawWorker(f: Awaited<ReturnType<typeof fixture>>) {
	const directory = await mkdtemp(join(f.root, "raw-"));
	await chmod(directory, 0o700);
	const installation = f.installation;
	const request = npmUpdateRequestSchema.parse({
		schemaVersion: 1,
		token: "f".repeat(64),
		createdAt: Date.now(),
		parentPid: f.parent.pid,
		authorizationTimeoutMs: 5_000,
		parentExitTimeoutMs: 1_000,
		verificationTimeoutMs: 500,
		targetVersion: "1.1.0",
		node: await identifyUpdateFile(process.execPath),
		npm: await identifyUpdateFile(join(installation.owner.prefix, "lib/node_modules/npm/bin/npm-cli.js")),
		installation: {
			appPath: installation.appPath,
			receiptPath: installation.receiptPath,
			installId: installation.installId,
			version: installation.version,
			buildId: installation.buildId,
			appAsarSha256: installation.appAsarSha256,
			owner: installation.owner,
		},
	});
	await copyFile(workerPath, join(directory, "worker.mjs"));
	await writeFile(join(directory, "request.json"), JSON.stringify(request), { mode: 0o600 });
	let resolveChannel: (channel: NpmUpdateChannel) => void = () => {};
	const admitted = new Promise<NpmUpdateChannel>((resolve) => {
		resolveChannel = resolve;
	});
	const server = createServer((socket) => resolveChannel(new NpmUpdateChannel(socket)));
	rawServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(join(directory, "control.sock"), resolve);
	});
	const child = spawn(request.node.path, [join(directory, "worker.mjs"), directory], {
		env: { PATH: "/usr/bin:/bin" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout?.on("data", (bytes: Buffer) => {
		output += bytes.toString();
	});
	child.stderr?.on("data", (bytes: Buffer) => {
		output += bytes.toString();
	});
	const finished = new Promise<{ code: number | null; output: string }>((resolve) =>
		child.once("exit", (code) => resolve({ code, output })),
	);
	const channel = await admitted;
	expect(await channel.next()).toEqual({ kind: "hello", token: request.token });
	await channel.send({ kind: "environment", environment: f.environment });
	expect(await channel.next()).toEqual({ kind: "ready" });
	return { channel, finished, directory };
}

// These process integration tests probe external Node/npm and repeatedly hash the real
// Node executable. Intel CI can exceed Vitest's 5s default before the protocol assertions;
// allow the same 15s integration budget as root tests, preserving worker deadlines and assertions.
describe("private npm update handoff", { timeout: 15_000 }, () => {
	it.each([undefined, "browser", "desktop"])(
		"explicitly updates the desktop pair with inherited %s install mode",
		(installMode) => {
			expect(
				updateEnvironment({ QUARTERDECK_INSTALL_MODE: installMode }, "/usr/local/bin/node")
					.QUARTERDECK_INSTALL_MODE,
			).toBe("desktop");
			expect(npmUpdateRetryCommand("/synthetic/prefix", "1.1.0")).toBe(
				"QUARTERDECK_INSTALL_MODE=desktop npm 'install' '--global' '--prefix' '/synthetic/prefix' '--registry=https://registry.npmjs.org/' '--foreground-scripts' 'quarterdeck@1.1.0'",
			);
		},
	);
	it("acknowledges readiness, waits for parent exit, updates the exact owning prefix, and removes private files", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		expect(await exists(f.tracePath)).toBe(false);
		await handoff.authorize();
		handoff.commit();
		expect(await exists(f.tracePath)).toBe(false);
		await stop(f.parent);
		expect(await f.finished()).toMatchObject({
			code: 0,
			output: expect.stringContaining("1.1.0 and its desktop app were verified"),
		});
		const trace = JSON.parse(await readFile(f.tracePath, "utf8"));
		expect(trace.args).toEqual(npmUpdateArguments(f.installation.owner.prefix, "1.1.0"));
		expect(trace.installMode).toBe("desktop");
		expect(trace.PATH.split(":")[0]).toBe(dirname(await realpath(process.execPath)));
		expect(trace.PATH).not.toContain(f.installation.appPath);
		expect(trace.PATH).not.toContain(f.installation.owner.packageRoot);
		expect(trace.lockFd).toBeUndefined();
		expect(trace.nodeOptions).toBeUndefined();
		expect(trace.secret).toBe("synthetic-in-memory-only");
		await expect(readdir(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["ready", "armed", "committed"])("cancels without npm from %s", async (state) => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		if (state !== "ready") await handoff.authorize();
		if (state === "committed") handoff.commit();
		await handoff.cancel();
		expect(await f.finished()).toMatchObject({ code: 0, output: expect.stringContaining("cancelled") });
		expect(await exists(f.tracePath)).toBe(false);
		await expect(readdir(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses owner changes after shutdown authorization", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		await writeFile(f.installation.receiptPath, JSON.stringify({ ...f.receipt, installId: randomUUID() }));
		await stop(f.parent);
		expect(await f.finished()).toMatchObject({ code: 1, output: expect.stringContaining("owner changed") });
		expect(await exists(f.tracePath)).toBe(false);
	});

	it.each([false, true])("cancels despite a failed cancellation marker, committed=%s", async (committed) => {
		const f = await fixture();
		const handoff = await f.prepare({
			writeCancellationMarker: async () => {
				throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
			},
		});
		await handoff.launch();
		await handoff.authorize();
		if (committed) handoff.commit();
		await handoff.cancel();
		await stop(f.parent);
		expect((await f.finished()).code).toBe(0);
		expect(await exists(f.tracePath)).toBe(false);
		await expect(readdir(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not install when an armed parent exits without a final commit", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		await stop(f.parent);
		expect((await f.finished()).code).toBe(1);
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("does not install when the parent disappears without authorization", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await stop(f.parent);
		expect(await f.finished()).toMatchObject({ code: 1, output: expect.stringContaining("not authorized") });
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("bounds an authorized parent that never exits", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		expect(await f.finished()).toMatchObject({ code: 1, output: expect.stringContaining("did not exit") });
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("cannot install after an authorization ACK is lost before commit", async () => {
		const f = await fixture();
		const worker = await rawWorker(f);
		await worker.channel.send({ kind: "authorize" });
		expect(await worker.channel.next()).toEqual({ kind: "authorized" });
		worker.channel.socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await stop(f.parent);
		expect((await worker.finished).code).toBe(1);
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("allows committed clean shutdown to outlast socket teardown without a 100ms assumption", async () => {
		const f = await fixture();
		const worker = await rawWorker(f);
		await worker.channel.send({ kind: "authorize" });
		expect(await worker.channel.next()).toEqual({ kind: "authorized" });
		await worker.channel.send({ kind: "commit" });
		worker.channel.socket.end();
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(await exists(f.tracePath)).toBe(false);
		await stop(f.parent);
		expect(await worker.finished).toMatchObject({ code: 0, output: expect.stringContaining("were verified") });
	});

	it.each(["failure", "mismatch", "owner", "pending"])(
		"shows visible failure and exact retry guidance for %s",
		async (mode) => {
			const f = await fixture(mode);
			const handoff = await f.prepare();
			await handoff.launch();
			await handoff.authorize();
			handoff.commit();
			await stop(f.parent);
			const result = await f.finished();
			expect(result.code).toBe(1);
			expect(result.output).toContain("synthetic npm lifecycle output");
			expect(result.output).toContain("quarterdeck@1.1.0");
			expect(result.output).toContain("did not complete");
			await expect(readdir(f.directory())).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("preserves ignore-scripts policy and rejects npm exit zero with an old pair", async () => {
		const f = await fixture("success", { npm_config_ignore_scripts: "true" });
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		await stop(f.parent);
		expect((await f.finished()).code).toBe(1);
		expect(JSON.parse(await readFile(f.tracePath, "utf8")).ignoreScripts).toBe("true");
	});

	it.each([
		{ bound: 500, expected: 0 },
		{ bound: 100, expected: 1 },
	])("uses a separate bounded full-pair verification deadline: $bound ms", async ({ bound, expected }) => {
		const f = await fixture("success", { TEST_STATUS_DELAY_MS: "200" });
		const handoff = await f.prepare({ verificationTimeoutMs: bound });
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		await stop(f.parent);
		expect((await f.finished()).code).toBe(expected);
	});

	it("rejects missing external Node/npm and offers a pinned manual command", async () => {
		const f = await fixture("success", { PATH: "/synthetic/missing" });
		await expect(f.prepare()).rejects.toBeInstanceOf(NpmUpdatePreparationError);
		await expect(f.prepare()).rejects.toThrow("quarterdeck@1.1.0");
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("rejects a PATH with Node but no npm without consulting a global prefix", async () => {
		const f = await fixture();
		const nodeOnly = join(f.root, "node-only");
		await mkdir(nodeOnly);
		await symlink(process.execPath, join(nodeOnly, "node"));
		f.environment.PATH = nodeOnly;
		await expect(f.prepare()).rejects.toBeInstanceOf(NpmUpdatePreparationError);
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("does not accept bundled Node as the external update tool", async () => {
		const f = await fixture();
		const bundled = join(f.installation.appPath, "Contents/Resources/runtime/bin");
		await mkdir(bundled, { recursive: true });
		await writeFile(join(bundled, "node"), "#!/bin/sh\necho v22.22.2\n", { mode: 0o700 });
		f.environment.PATH = bundled;
		await expect(f.prepare()).rejects.toBeInstanceOf(NpmUpdatePreparationError);
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("rejects external Node with a different architecture before preparing a handoff", async () => {
		const f = await fixture();
		f.installation.arch = process.arch === "arm64" ? "x64" : "arm64";
		await expect(f.prepare()).rejects.toThrow("same architecture");
		expect(await exists(f.tracePath)).toBe(false);
		expect(await readdir(f.root)).not.toContain(`quarterdeck-npm-updates-${process.getuid?.()}`);
	});

	it("rejects an npm executable that changes while Quarterdeck shuts down", async () => {
		const f = await fixture();
		const handoff = await f.prepare();
		await handoff.launch();
		await handoff.authorize();
		handoff.commit();
		const npm = join(f.installation.owner.prefix, "lib/node_modules/npm/bin/npm-cli.js");
		await writeFile(npm, `${await readFile(npm, "utf8")}\n// changed\n`);
		await stop(f.parent);
		expect(await f.finished()).toMatchObject({ code: 1, output: expect.stringContaining("Node or npm changed") });
		expect(await exists(f.tracePath)).toBe(false);
	});

	it("refuses an overlong private socket path and cleans the allocation", async () => {
		const f = await fixture();
		const longRoot = join(f.root, "long-temporary-root-".repeat(5));
		await mkdir(longRoot);
		await expect(f.prepare({ temporaryRoot: longRoot })).rejects.toBeInstanceOf(NpmUpdatePreparationError);
		expect(await readdir(join(longRoot, `quarterdeck-npm-updates-${process.getuid?.()}`))).toEqual([]);
	});

	it("requires readiness before shutdown and removes a never-started Terminal handoff", async () => {
		const f = await fixture();
		const handoff = await f.prepare({ readinessTimeoutMs: 100, launchTerminal: async () => {} });
		await expect(handoff.authorize()).rejects.toThrow("not ready");
		await expect(handoff.launch()).rejects.toThrow("did not acknowledge");
		expect(await exists(f.tracePath)).toBe(false);
		expect(await readdir(join(f.root, `quarterdeck-npm-updates-${process.getuid?.()}`))).toEqual([]);
	});

	it("bounds abandoned handoffs and reports their exact inspection directory", async () => {
		const f = await fixture();
		const root = join(f.root, `quarterdeck-npm-updates-${process.getuid?.()}`);
		await mkdir(root, { mode: 0o700 });
		await Promise.all([0, 1, 2, 3].map((index) => mkdir(join(root, `retained-${index}`))));
		await expect(f.prepare()).rejects.toThrow(`Four update handoffs remain in ${root}`);
		expect((await readdir(root)).length).toBe(4);
	});

	it("retains unrecognized files during conservative cleanup", async () => {
		const root = await mkdtemp(join(suite, "unknown-"));
		await writeFile(join(root, "unrecognized"), "keep");
		await expect(cleanupNpmUpdateDirectory(root)).rejects.toThrow("Unrecognized");
		expect(await readFile(join(root, "unrecognized"), "utf8")).toBe("keep");
	});
});
