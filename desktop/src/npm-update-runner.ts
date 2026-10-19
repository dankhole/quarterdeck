import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DesktopInstallation } from "../../src/desktop-install/index.js";
import { desktopVersionSchema } from "../../src/desktop-install/receipt.js";
import {
	captureUpdateCommand,
	cleanupNpmUpdateDirectory,
	externalUpdateEnvironment,
	identifyUpdateFile,
	isWithin,
	NpmUpdateChannel,
	type NpmUpdateRequest,
	npmUpdateRequestSchema,
	npmUpdateRetryCommand,
	readUpdateJson,
	shellArgument,
	updateEnvironment,
	validateUpdateDirectory,
	verifyNpmUpdateOwner,
} from "./npm-update-worker.js";

export interface PreparedNpmUpdate {
	launch(): Promise<void>;
	authorize(): Promise<void>;
	commit(): void;
	cancel(): Promise<void>;
}

export interface PrepareNpmUpdateOptions {
	installation: DesktopInstallation;
	targetVersion: string;
	environment: Readonly<NodeJS.ProcessEnv>;
	parentPid?: number;
}

/** Native main/testing dependencies. None can be supplied by the renderer. */
export interface NpmUpdatePreparationServices {
	workerPath?: string;
	temporaryRoot?: string;
	launchTerminal?: (commandPath: string, nodePath: string, workerPath: string, directory: string) => Promise<void>;
	readinessTimeoutMs?: number;
	authorizationTimeoutMs?: number;
	parentExitTimeoutMs?: number;
	verificationTimeoutMs?: number;
	writeCancellationMarker?: (path: string) => Promise<void>;
}

export class NpmUpdatePreparationError extends Error {
	constructor(reason: string, installation: DesktopInstallation, targetVersion: string) {
		super(
			`${reason}\n\nQuit Quarterdeck, then run:\n${npmUpdateRetryCommand(installation.owner.prefix, targetVersion)}`,
		);
		this.name = "NpmUpdatePreparationError";
	}
}

/** Only fixed native validation messages may appear in a preparation dialog. */
class NpmUpdateCheckError extends Error {}

function bounded<T>(promise: Promise<T>, milliseconds: number, reason: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(reason)), milliseconds);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function executableFromPath(
	name: string,
	environment: Readonly<NodeJS.ProcessEnv>,
	roots: string[],
): Promise<string> {
	for (const directory of (environment.PATH ?? "").split(":")) {
		if (!isAbsolute(directory) || /[\0\r\n]/u.test(directory)) continue;
		try {
			const path = await realpath(join(directory, name));
			if (roots.some((root) => isWithin(root, path))) continue;
			await access(path, constants.X_OK);
			if ((await lstat(path)).isFile()) return path;
		} catch {
			/* Missing PATH entries are ordinary; never try a login shell or bundled fallback. */
		}
	}
	throw new NpmUpdateCheckError(`A usable external ${name} was not found in the desktop launch PATH.`);
}

async function resolveToolchain(options: PrepareNpmUpdateOptions): Promise<Pick<NpmUpdateRequest, "node" | "npm">> {
	const roots = [await realpath(options.installation.appPath), await realpath(options.installation.owner.packageRoot)];
	const nodePath = await executableFromPath("node", options.environment, roots);
	const npmPath = await executableFromPath("npm", options.environment, roots);
	if (!npmPath.endsWith("/bin/npm-cli.js"))
		throw new NpmUpdateCheckError("The desktop launch PATH does not select a standard external npm installation.");
	const metadata = z
		.object({ name: z.literal("npm"), version: z.string().regex(/^\d+\.\d+\.\d+$/u) })
		.parse(await readUpdateJson(join(dirname(npmPath), "../package.json")));
	if (Number(metadata.version.split(".")[0]) < 10)
		throw new NpmUpdateCheckError("External npm 10 or newer is required.");
	const environment = updateEnvironment(options.environment, nodePath);
	const nodeVersion = await captureUpdateCommand(nodePath, ["--version"], environment);
	const version = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(nodeVersion);
	if (
		!version ||
		Number(version[1]) < 22 ||
		(Number(version[1]) === 22 && (Number(version[2]) < 22 || (Number(version[2]) === 22 && Number(version[3]) < 2)))
	)
		throw new NpmUpdateCheckError("External Node 22.22.2 or newer is required.");
	if ((await captureUpdateCommand(nodePath, [npmPath, "--version"], environment)) !== metadata.version)
		throw new NpmUpdateCheckError("The external npm executable does not match its package identity.");
	if ((await captureUpdateCommand(nodePath, ["-p", "process.arch"], environment)) !== options.installation.arch)
		throw new NpmUpdateCheckError("External Node must use the same architecture as the installed desktop app.");
	return { node: await identifyUpdateFile(nodePath), npm: await identifyUpdateFile(npmPath) };
}

async function openTerminal(commandPath: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		execFile(
			"/usr/bin/open",
			["-a", "Terminal", commandPath],
			{ cwd: "/", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeout: 5_000, maxBuffer: 4_096 },
			(error) => (error ? reject(new Error("Terminal could not open the update handoff.")) : resolve()),
		);
	});
}

async function allocateDirectory(options: PrepareNpmUpdateOptions, temporaryRoot?: string): Promise<string> {
	// Darwin's per-user TMPDIR is often too long for a Unix-domain socket (104 bytes).
	const temporary = await realpath(temporaryRoot ?? (process.platform === "darwin" ? "/private/tmp" : tmpdir()));
	const root = join(temporary, `quarterdeck-npm-updates-${process.getuid?.()}`);
	await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	await validateUpdateDirectory(root);
	if ((await readdir(root)).length >= 4)
		throw new NpmUpdateCheckError(
			`Four update handoffs remain in ${root}. Inspect and remove abandoned handoff files before trying again.`,
		);
	const directory = await mkdtemp(join(root, "handoff-"));
	await chmod(directory, 0o700);
	if (Buffer.byteLength(join(directory, "control.sock")) >= 104) {
		await cleanupNpmUpdateDirectory(directory);
		throw new NpmUpdateCheckError("The private update handoff path is too long for macOS IPC.");
	}
	if (
		[options.installation.appPath, options.installation.owner.packageRoot].some((path) => isWithin(path, directory))
	) {
		await cleanupNpmUpdateDirectory(directory);
		throw new NpmUpdateCheckError("The temporary handoff directory is inside the installation being replaced.");
	}
	return directory;
}

/** Prepares an inert worker; only an explicit final commit and parent exit permit npm. */
export async function prepareNpmUpdate(
	options: PrepareNpmUpdateOptions,
	services: NpmUpdatePreparationServices = {},
): Promise<PreparedNpmUpdate> {
	let directory: string | undefined;
	try {
		if (
			options.installation.owner.kind !== "npm" ||
			options.installation.source !== "release" ||
			options.installation.cleanupPending ||
			!desktopVersionSchema.safeParse(options.targetVersion).success
		)
			throw new NpmUpdateCheckError("This installation cannot use an app-driven npm update.");
		const tools = await resolveToolchain(options);
		const request = npmUpdateRequestSchema.parse({
			schemaVersion: 1,
			token: randomBytes(32).toString("hex"),
			createdAt: Date.now(),
			parentPid: options.parentPid ?? process.pid,
			authorizationTimeoutMs: services.authorizationTimeoutMs ?? 300_000,
			parentExitTimeoutMs: services.parentExitTimeoutMs ?? 60_000,
			// Full signed-app status includes hashing and macOS signature/Gatekeeper verification.
			verificationTimeoutMs: services.verificationTimeoutMs ?? 300_000,
			installation: {
				appPath: options.installation.appPath,
				receiptPath: options.installation.receiptPath,
				installId: options.installation.installId,
				version: options.installation.version,
				buildId: options.installation.buildId,
				appAsarSha256: options.installation.appAsarSha256,
				owner: options.installation.owner,
			},
			targetVersion: options.targetVersion,
			...tools,
		});
		await verifyNpmUpdateOwner(request);
		const environment = await externalUpdateEnvironment(options.environment, request);
		directory = await allocateDirectory(options, services.temporaryRoot);
		const handoff = directory;
		const workerPath = join(handoff, "worker.mjs");
		const commandPath = join(handoff, "Update.command");
		await copyFile(
			services.workerPath ?? fileURLToPath(new URL("./npm-update-worker.mjs", import.meta.url)),
			workerPath,
			constants.COPYFILE_EXCL,
		);
		await chmod(workerPath, 0o600);
		await writeFile(join(handoff, "request.json"), JSON.stringify(request), { flag: "wx", mode: 0o600 });
		await writeFile(
			commandPath,
			`#!/bin/sh\nexec /usr/bin/env -i ${shellArgument(tools.node.path)} ${shellArgument(workerPath)} ${shellArgument(handoff)}\n`,
			{ flag: "wx", mode: 0o700 },
		);
		let channel: NpmUpdateChannel | undefined;
		let state: "prepared" | "launching" | "ready" | "armed" | "committed" | "cancelled" = "prepared";
		let readyResolve: () => void = () => {};
		let readyReject: (error: unknown) => void = () => {};
		const readiness = new Promise<void>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		// Observe rejection even if Terminal reports a launch error before the caller starts waiting.
		void readiness.catch(() => {});
		const server = createServer((socket) => {
			if (channel || state !== "launching") {
				socket.destroy();
				return;
			}
			channel = new NpmUpdateChannel(socket);
			const admitted = channel;
			void (async () => {
				z.strictObject({ kind: z.literal("hello"), token: z.literal(request.token) }).parse(await admitted.next());
				await admitted.send({
					kind: "environment",
					environment: Object.fromEntries(
						Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
					),
				});
				z.strictObject({ kind: z.literal("ready") }).parse(await admitted.next());
				if (state !== "launching") throw new Error("The update handoff was cancelled.");
				state = "ready";
				readyResolve();
			})().catch((error: unknown) => {
				readyReject(error);
				socket.destroy();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(join(handoff, "control.sock"), () => {
				server.off("error", reject);
				resolve();
			});
		});
		server.on("error", (error) => readyReject(error));
		const close = async (): Promise<void> => {
			channel?.socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		};
		const cancel = async (): Promise<void> => {
			if (state === "cancelled") return;
			const wasReady = state === "ready" || state === "armed" || state === "committed";
			state = "cancelled";
			let revoked = false;
			try {
				await (
					services.writeCancellationMarker ??
					((path) => writeFile(path, "cancelled\n", { mode: 0o600, flag: "wx" }))
				)(join(handoff, "cancelled"));
				revoked = true;
			} catch (error) {
				if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) revoked = true;
			}
			try {
				if (wasReady && channel) {
					await bounded(
						(async () => {
							await channel?.send({ kind: "cancel" });
							z.strictObject({ kind: z.literal("cancelled") }).parse(await channel?.next());
						})(),
						2_000,
						"Update cancellation acknowledgement expired.",
					);
					revoked = true;
				}
			} catch {
				/* Revoke the original request if the worker cannot acknowledge cancellation. */
			} finally {
				try {
					await unlink(join(handoff, "request.json"));
					revoked = true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") revoked = true;
				}
				await close();
			}
			if (!revoked) throw new Error("The update cancellation could not revoke its private handoff.");
			try {
				await cleanupNpmUpdateDirectory(handoff);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		};
		return {
			async launch() {
				if (state !== "prepared") throw new Error("The update handoff has already launched or was cancelled.");
				state = "launching";
				try {
					await (services.launchTerminal ?? openTerminal)(commandPath, tools.node.path, workerPath, handoff);
					await bounded(
						readiness,
						services.readinessTimeoutMs ?? 15_000,
						"The visible update worker did not become ready.",
					);
				} catch {
					await cancel();
					throw new NpmUpdatePreparationError(
						"Terminal did not acknowledge a ready update worker. npm was not run.",
						options.installation,
						options.targetVersion,
					);
				}
			},
			async authorize() {
				if (state !== "ready" || !channel)
					throw new Error("The update worker is not ready for clean shutdown authorization.");
				try {
					await bounded(
						(async () => {
							await channel.send({ kind: "authorize" });
							z.strictObject({ kind: z.literal("authorized") }).parse(await channel.next());
						})(),
						2_000,
						"The update worker did not acknowledge authorization.",
					);
				} catch {
					await cancel();
					throw new NpmUpdatePreparationError(
						"The update worker did not acknowledge authorization. npm was not run.",
						options.installation,
						options.targetVersion,
					);
				}
				state = "armed";
			},
			commit() {
				if (state !== "armed" || !channel)
					throw new Error("The update worker has not acknowledged clean shutdown authorization.");
				// Queue the fixed final frame synchronously, immediately before app.quit().
				// A lost frame fails closed: parent death alone never authorizes npm.
				channel.commit();
				state = "committed";
				// Do not await server.close while its live worker socket waits for this app to exit.
				// Teardown must never turn an accepted final frame into a thrown failed commit.
				try {
					server.close();
					server.unref();
					channel.socket.unref();
				} catch {
					/* Process teardown closes any remaining listener and socket. */
				}
			},
			cancel,
		};
	} catch (error) {
		if (directory) await cleanupNpmUpdateDirectory(directory).catch(() => {});
		if (error instanceof NpmUpdatePreparationError) throw error;
		// Keep external command output, environment values and metadata validation dumps out of native dialogs.
		throw new NpmUpdatePreparationError(
			error instanceof NpmUpdateCheckError
				? error.message
				: "Quarterdeck could not prepare a verified external Node/npm update. Check the owning installation and desktop launch PATH.",
			options.installation,
			desktopVersionSchema.safeParse(options.targetVersion).success
				? options.targetVersion
				: options.installation.version,
		);
	}
}
