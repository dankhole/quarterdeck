import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { desktopVersionSchema, managedDesktopInstallationReceiptSchema } from "../../src/desktop-install/receipt.js";
import {
	desktopBuildIdentitySchema,
	desktopInstallationOwnerSchema,
} from "../../src/shared/desktop-installation-contract.js";

const pathSchema = z
	.string()
	.startsWith("/")
	.max(4096)
	.refine((value) => !/[\0\r\n]/u.test(value));
const fileIdentitySchema = z.strictObject({
	path: pathSchema,
	dev: z.number(),
	ino: z.number(),
	size: z.number(),
	mtimeMs: z.number(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const npmUpdateRequestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	token: z.string().regex(/^[a-f0-9]{64}$/u),
	createdAt: z.number(),
	parentPid: z.number().int().positive(),
	authorizationTimeoutMs: z.number().int().min(100).max(300_000),
	parentExitTimeoutMs: z.number().int().min(100).max(60_000),
	verificationTimeoutMs: z.number().int().min(100).max(300_000),
	installation: z.strictObject({
		appPath: pathSchema,
		receiptPath: pathSchema,
		installId: z.uuid(),
		version: desktopVersionSchema,
		buildId: z.uuid(),
		appAsarSha256: z.string().regex(/^[a-f0-9]{64}$/u),
		owner: desktopInstallationOwnerSchema,
	}),
	targetVersion: desktopVersionSchema,
	node: fileIdentitySchema,
	npm: fileIdentitySchema,
});
export type NpmUpdateRequest = z.infer<typeof npmUpdateRequestSchema>;
export type NpmUpdateFileIdentity = z.infer<typeof fileIdentitySchema>;

export function shellArgument(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function npmUpdateArguments(prefix: string, targetVersion: string): string[] {
	return [
		"install",
		"--global",
		"--prefix",
		prefix,
		"--registry=https://registry.npmjs.org/",
		"--foreground-scripts",
		`quarterdeck@${targetVersion}`,
	];
}

export function npmUpdateRetryCommand(prefix: string, targetVersion: string): string {
	return [
		"QUARTERDECK_INSTALL_MODE=desktop",
		"npm",
		...npmUpdateArguments(prefix, targetVersion).map(shellArgument),
	].join(" ");
}

export function isWithin(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function readUpdateJson(path: string, maximumBytes = 128 * 1024): Promise<unknown> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
		throw new Error("Update metadata is not a bounded regular file.");
	const bytes = await readFile(path);
	if (bytes.length > maximumBytes) throw new Error("Update metadata exceeded its limit.");
	return JSON.parse(bytes.toString("utf8")) as unknown;
}

export async function identifyUpdateFile(path: string): Promise<NpmUpdateFileIdentity> {
	const canonical = await realpath(path);
	const info = await lstat(canonical);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Update tools must be regular files.");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(canonical)) hash.update(chunk);
	const after = await lstat(canonical);
	if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs)
		throw new Error("An update tool changed while checking it.");
	return {
		path: canonical,
		dev: info.dev,
		ino: info.ino,
		size: info.size,
		mtimeMs: info.mtimeMs,
		sha256: hash.digest("hex"),
	};
}

export async function checkUpdateTool(identity: NpmUpdateFileIdentity): Promise<void> {
	if (JSON.stringify(await identifyUpdateFile(identity.path)) !== JSON.stringify(identity))
		throw new Error("The external Node or npm changed. Check for updates again.");
}

export function updateEnvironment(environment: Readonly<NodeJS.ProcessEnv>, nodePath: string): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(environment)) {
		if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes("\0")) continue;
		if (
			/^(?:NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_INSPECT_RESUME_ON_START|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|ELECTRON_RUN_AS_NODE|VSCODE_INSPECTOR_OPTIONS|VSCODE_DEBUG_SETTINGS|DYLD_.*|LD_PRELOAD|LD_LIBRARY_PATH)$/iu.test(
				name,
			)
		)
			continue;
		if (/^QUARTERDECK_/iu.test(name)) continue;
		if (/^(?:npm_execpath|npm_node_execpath|npm_lifecycle_.*|INIT_CWD)$/iu.test(name)) continue;
		result[name] = value;
	}
	result.QUARTERDECK_INSTALL_MODE = "desktop";
	result.PATH = [dirname(nodePath), ...(result.PATH ?? "").split(":"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
		.filter((path, index, paths) => isAbsolute(path) && !/[\0\r\n]/u.test(path) && paths.indexOf(path) === index)
		.join(":");
	return result;
}

/** Lifecycle scripts must resolve Node outside the app and npm package being replaced. */
export async function externalUpdateEnvironment(
	environment: Readonly<NodeJS.ProcessEnv>,
	request: Pick<NpmUpdateRequest, "node" | "installation">,
): Promise<NodeJS.ProcessEnv> {
	const result = updateEnvironment(environment, request.node.path);
	const paths: string[] = [];
	for (const entry of (result.PATH ?? "").split(":")) {
		try {
			const path = await realpath(entry);
			if (
				![request.installation.appPath, request.installation.owner.packageRoot].some((root) =>
					isWithin(root, path),
				) &&
				!paths.includes(path)
			)
				paths.push(path);
		} catch {
			/* Missing launch PATH entries cannot help this one-shot execution. */
		}
	}
	if (paths[0] !== dirname(request.node.path))
		throw new Error("npm lifecycle scripts do not have the checked external Node first in PATH.");
	if ((await realpath(join(paths[0], "node"))) !== request.node.path)
		throw new Error("npm lifecycle scripts would not resolve the checked external Node.");
	result.PATH = paths.join(":");
	return result;
}

export function captureUpdateCommand(
	executable: string,
	args: string[],
	environment: NodeJS.ProcessEnv,
	timeoutMs = 5_000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			executable,
			args,
			{ env: environment, cwd: "/", shell: false, timeout: timeoutMs, maxBuffer: 128 * 1024, encoding: "utf8" },
			(error, stdout) => {
				if (error) reject(new Error("An update tool could not complete its bounded check."));
				else resolve(stdout.trim());
			},
		);
	});
}

/** Fixed-format private IPC; the environment stays in memory and never enters request files. */
export class NpmUpdateChannel {
	private buffer = "";
	private messages: unknown[] = [];
	private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
	private failure: Error | null = null;
	constructor(readonly socket: Socket) {
		socket.setEncoding("utf8");
		socket.on("data", (bytes: string) => {
			this.buffer += bytes;
			if (Buffer.byteLength(this.buffer) > 512 * 1024) {
				this.fail();
				return;
			}
			let index = this.buffer.indexOf("\n");
			while (index !== -1) {
				let message: unknown;
				try {
					message = JSON.parse(this.buffer.slice(0, index)) as unknown;
				} catch {
					this.fail();
					return;
				}
				this.buffer = this.buffer.slice(index + 1);
				if (this.pending) {
					const pending = this.pending;
					this.pending = null;
					pending.resolve(message);
				} else if (this.messages.length < 4) this.messages.push(message);
				else {
					this.fail();
					return;
				}
				index = this.buffer.indexOf("\n");
			}
		});
		socket.on("error", () => this.fail());
		socket.on("close", () => this.fail());
	}
	private fail(): void {
		this.failure ??= new Error("The update handoff closed before completion.");
		this.pending?.reject(this.failure);
		this.pending = null;
		this.socket.destroy();
	}
	async send(message: unknown): Promise<void> {
		if (this.failure) throw this.failure;
		await new Promise<void>((resolve, reject) =>
			this.socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve())),
		);
	}
	commit(): void {
		if (this.failure || this.socket.destroyed || !this.socket.writable)
			throw new Error("The update handoff closed before final shutdown commit.");
		this.socket.write('{"kind":"commit"}\n');
	}
	next(): Promise<unknown> {
		if (this.messages.length) return Promise.resolve(this.messages.shift());
		if (this.failure) return Promise.reject(this.failure);
		if (this.pending) return Promise.reject(new Error("Concurrent update channel reads are invalid."));
		return new Promise((resolve, reject) => {
			this.pending = { resolve, reject };
		});
	}
}

export async function validateUpdateDirectory(directory: string): Promise<void> {
	const info = await lstat(directory);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.uid !== process.getuid?.() ||
		(info.mode & 0o077) !== 0 ||
		(await realpath(directory)) !== directory
	)
		throw new Error("The update handoff is not a real private directory.");
}

/** Delete only this protocol's recognized files, never recursive arbitrary directory contents. */
export async function cleanupNpmUpdateDirectory(directory: string): Promise<void> {
	await validateUpdateDirectory(directory);
	const names = await readdir(directory);
	const recognized = new Set(["request.json", "worker.mjs", "Update.command", "control.sock", "cancelled"]);
	if (names.some((name) => !recognized.has(name))) throw new Error("Unrecognized handoff files were retained.");
	for (const name of names) {
		const path = join(directory, name);
		const info = await lstat(path);
		if (
			info.isSymbolicLink() ||
			info.uid !== process.getuid?.() ||
			(!info.isFile() && !(name === "control.sock" && info.isSocket()))
		)
			throw new Error("Changed handoff files were retained.");
	}
	for (const name of names)
		await unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	await rmdir(directory);
}

export async function verifyNpmUpdateOwner(request: NpmUpdateRequest): Promise<void> {
	const installation = request.installation;
	const owner = installation.owner;
	for (const path of [owner.prefix, owner.packageSlot, owner.packageRoot]) pathSchema.parse(path);
	const receipt = managedDesktopInstallationReceiptSchema.parse(await readUpdateJson(installation.receiptPath));
	if (
		owner.kind !== "npm" ||
		owner.packageSlot !== join(owner.prefix, "lib/node_modules/quarterdeck") ||
		owner.packageSlot !== owner.packageRoot ||
		(await realpath(owner.prefix)) !== owner.prefix ||
		(await realpath(owner.packageSlot)) !== owner.packageRoot ||
		(await lstat(owner.packageSlot)).isSymbolicLink()
	)
		throw new Error("The owning npm package slot changed. No update was started.");
	if (
		receipt.installId !== installation.installId ||
		receipt.appPath !== installation.appPath ||
		receipt.version !== installation.version ||
		receipt.buildId !== installation.buildId ||
		receipt.appAsarSha256 !== installation.appAsarSha256 ||
		JSON.stringify(receipt.owner) !== JSON.stringify(owner)
	)
		throw new Error("The desktop installation owner changed. No update was started.");
	await access(owner.prefix, constants.W_OK);
	await access(dirname(owner.packageSlot), constants.W_OK);
	try {
		await lstat(join(dirname(installation.receiptPath), "transaction.json"));
		throw new Error("An installation transaction is pending.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const metadata = z
		.object({ name: z.literal("quarterdeck"), version: z.literal(installation.version) })
		.parse(await readUpdateJson(join(owner.packageRoot, "package.json")));
	const identity = desktopBuildIdentitySchema.parse(
		await readUpdateJson(join(owner.packageRoot, "dist/build-manifest.json")),
	);
	if (metadata.version !== owner.identity.version || JSON.stringify(identity) !== JSON.stringify(owner.identity))
		throw new Error("The owning npm package identity changed. No update was started.");
}

function parentIsDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForParentExit(request: NpmUpdateRequest, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + request.parentExitTimeoutMs;
	while (!parentIsDead(request.parentPid)) {
		if (signal.aborted) throw new Error("Update cancelled while waiting for Quarterdeck to exit.");
		if (Date.now() >= deadline)
			throw new Error("Quarterdeck did not exit before the update deadline. No npm command was run.");
		await wait(100);
	}
}

async function runVisibleNpm(request: NpmUpdateRequest, environment: NodeJS.ProcessEnv): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			request.node.path,
			[request.npm.path, ...npmUpdateArguments(request.installation.owner.prefix, request.targetVersion)],
			{
				env: environment,
				cwd: "/",
				shell: false,
				stdio: ["inherit", "inherit", "inherit"],
			},
		);
		child.once("error", () => reject(new Error("npm could not start.")));
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`npm failed (${code === null ? "interrupted" : `exit ${code}`}).`)),
		);
	});
}

async function verifyUpdatedPair(request: NpmUpdateRequest, environment: NodeJS.ProcessEnv): Promise<void> {
	const owner = request.installation.owner;
	if ((await realpath(owner.packageSlot)) !== owner.packageRoot || (await lstat(owner.packageSlot)).isSymbolicLink())
		throw new Error("The updated npm owner changed.");
	const cli = await realpath(join(owner.packageSlot, "dist/cli.js"));
	if (!isWithin(owner.packageRoot, cli)) throw new Error("The updated CLI is outside its owning package.");
	const result = JSON.parse(
		await captureUpdateCommand(
			request.node.path,
			[cli, "desktop", "status", "--json"],
			environment,
			request.verificationTimeoutMs,
		),
	) as unknown;
	const status = z
		.object({
			state: z.literal("ready"),
			pending: z.literal(false),
			installation: z.object({
				version: z.literal(request.targetVersion),
				appPath: z.literal(request.installation.appPath),
				cleanupPending: z.literal(false),
				owner: desktopInstallationOwnerSchema,
			}),
		})
		.parse(result);
	const updated = status.installation.owner;
	if (
		updated.kind !== "npm" ||
		updated.prefix !== owner.prefix ||
		updated.packageSlot !== owner.packageSlot ||
		updated.packageRoot !== owner.packageRoot ||
		updated.identity.version !== request.targetVersion
	)
		throw new Error("npm completed, but the desktop pair does not have the expected owner and version.");
}

/** All imports are bundled into the private copy before npm can replace either installation tree. */
export async function runNpmUpdateWorker(directory: string): Promise<number> {
	let request: NpmUpdateRequest | undefined;
	let channel: NpmUpdateChannel | undefined;
	const parentWait = new AbortController();
	try {
		await validateUpdateDirectory(directory);
		request = npmUpdateRequestSchema.parse(await readUpdateJson(join(directory, "request.json")));
		if (
			Date.now() - request.createdAt > 300_000 ||
			request.createdAt > Date.now() + 10_000 ||
			isWithin(request.installation.appPath, directory) ||
			isWithin(request.installation.owner.packageRoot, directory)
		)
			throw new Error("The update handoff expired or is inside replaceable files.");
		if ((await realpath(process.execPath)) !== request.node.path)
			throw new Error("The update worker is not using the checked external Node.");
		await Promise.all([checkUpdateTool(request.node), checkUpdateTool(request.npm), verifyNpmUpdateOwner(request)]);
		const socket = connect(join(directory, "control.sock"));
		channel = new NpmUpdateChannel(socket);
		await channel.send({ kind: "hello", token: request.token });
		const received = z
			.strictObject({ kind: z.literal("environment"), environment: z.record(z.string(), z.string()) })
			.parse(await channel.next());
		const environment = await externalUpdateEnvironment(received.environment, request);
		console.log(
			`Quarterdeck update: ${request.installation.version} → ${request.targetVersion}\nOwning npm prefix: ${request.installation.owner.prefix}\nWaiting for Quarterdeck to finish normal shutdown…`,
		);
		await channel.send({ kind: "ready" });
		const deadline = Date.now() + request.authorizationTimeoutMs;
		const parentPid = request.parentPid;
		const decision = channel.next();
		let monitor: ReturnType<typeof setInterval> | undefined;
		let action: { kind: "authorize" | "cancel" };
		try {
			const abandoned = new Promise<never>((_resolve, reject) => {
				monitor = setInterval(() => {
					if (Date.now() >= deadline || parentIsDead(parentPid) || socket.destroyed)
						reject(new Error("The update was not authorized before Quarterdeck exited or the handoff expired."));
				}, 100);
			});
			action = z
				.strictObject({ kind: z.enum(["authorize", "cancel"]) })
				.parse(await Promise.race([decision, abandoned]));
		} finally {
			clearInterval(monitor);
		}
		if (action.kind === "cancel") {
			await channel.send({ kind: "cancelled" });
			console.log("Update cancelled. npm was not run.");
			return 0;
		}
		await channel.send({ kind: "authorized" });
		// Main must receive our ACK before committing. A failed/lost ACK cannot
		// leave an authorized worker waiting for a later unrelated app quit.
		let commitMonitor: ReturnType<typeof setInterval> | undefined;
		let committed: { kind: "commit" | "cancel" };
		try {
			committed = z.strictObject({ kind: z.enum(["commit", "cancel"]) }).parse(
				await Promise.race([
					channel.next(),
					new Promise<never>((_resolve, reject) => {
						commitMonitor = setInterval(() => {
							if (Date.now() >= deadline || parentIsDead(parentPid) || socket.destroyed)
								reject(new Error("The update authorization was not committed. npm was not run."));
						}, 100);
					}),
				]),
			);
		} finally {
			clearInterval(commitMonitor);
		}
		if (committed.kind === "cancel") {
			await channel.send({ kind: "cancelled" });
			console.log("Update cancelled before shutdown authorization committed. npm was not run.");
			return 0;
		}
		const parentExit = waitForParentExit(request, parentWait.signal).then(() => "exited" as const);
		const cancellation = channel.next().then(
			(message) => {
				z.strictObject({ kind: z.literal("cancel") }).parse(message);
				return "cancelled" as const;
			},
			() => parentExit,
		);
		if ((await Promise.race([parentExit, cancellation])) === "cancelled") {
			await channel.send({ kind: "cancelled" });
			console.log("Update cancelled after shutdown authorization. npm was not run.");
			return 0;
		}
		socket.destroy();
		await validateUpdateDirectory(directory);
		const original = npmUpdateRequestSchema.parse(await readUpdateJson(join(directory, "request.json")));
		if (original.token !== request.token) throw new Error("The original update handoff changed.");
		try {
			await lstat(join(directory, "cancelled"));
			throw new Error("The update was cancelled before npm started.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await Promise.all([checkUpdateTool(request.node), checkUpdateTool(request.npm), verifyNpmUpdateOwner(request)]);
		await runVisibleNpm(request, environment);
		await verifyUpdatedPair(request, environment);
		console.log(
			`\nQuarterdeck ${request.targetVersion} and its desktop app were verified. Reopen Quarterdeck from Applications or the Dock.`,
		);
		return 0;
	} catch (error) {
		console.error(
			`\nQuarterdeck update did not complete: ${error instanceof Error && !(error instanceof z.ZodError) ? error.message : "the installation or handoff could not be verified."}`,
		);
		if (request)
			console.error(
				`\nQuit Quarterdeck before retrying this exact version:\n${npmUpdateRetryCommand(request.installation.owner.prefix, request.targetVersion)}\nThen inspect: quarterdeck desktop status\nIf npm reports success but hooks were skipped, run quarterdeck desktop install to repair the pair.`,
			);
		return 1;
	} finally {
		parentWait.abort();
		channel?.socket.destroy();
		try {
			await cleanupNpmUpdateDirectory(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				console.error(`Update handoff files were retained for inspection: ${directory}`);
		}
	}
}
