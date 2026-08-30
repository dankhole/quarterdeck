import * as fs from "node:fs";
import { createRequire } from "node:module";
import type * as NodePty from "node-pty";

import { mergeProcessEnvironment, resolveWindowsCompatibleCommand } from "../core";
import {
	type ManagedProcessOwnershipHandle,
	registerManagedProcessOwnership,
	retireManagedProcessOwnership,
} from "./managed-process-ownership";
import { classifyPtySpawnFailure, preflightPtyLaunch } from "./pty-runtime-health";

const require = createRequire(import.meta.url);
const MANAGED_PROCESS_PID_READY_TIMEOUT_MS = 10_000;
const MANAGED_PROCESS_PID_POLL_MS = 10;
let nodePtyModule: typeof NodePty | null = null;
let nodePtySpawnOverride: typeof NodePty.spawn | null = null;

function getNodePtySpawn(): typeof NodePty.spawn {
	if (nodePtySpawnOverride) return nodePtySpawnOverride;
	nodePtyModule ??= require("node-pty") as typeof NodePty;
	return nodePtyModule.spawn;
}

export const _testing = {
	setNodePtySpawnOverride(spawn: typeof NodePty.spawn | null): void {
		nodePtySpawnOverride = spawn;
	},
};

export interface PtyExitEvent {
	exitCode: number;
	signal?: number;
}

export interface SpawnPtySessionRequest {
	binary: string;
	args?: string[] | string;
	cwd: string;
	env?: Record<string, string | undefined>;
	cols: number;
	rows: number;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: PtyExitEvent) => void;
}

type PtyOutputChunk = string | Buffer | Uint8Array;

interface NodePtyWriteTask {
	buffer: Buffer;
	offset: number;
}

interface NodePtyCustomWriteStream {
	_fd: number;
	_writeQueue: NodePtyWriteTask[];
	_writeImmediate?: NodeJS.Immediate;
	_processWriteQueue: () => void;
}

interface NodePtyWithWriteStream extends NodePty.IPty {
	_writeStream?: unknown;
}

function normalizeOutputChunk(data: PtyOutputChunk): Buffer {
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNodePtyWriteTask(value: unknown): value is NodePtyWriteTask {
	if (!isObjectRecord(value)) {
		return false;
	}
	return Buffer.isBuffer(value.buffer) && typeof value.offset === "number";
}

function isNodePtyCustomWriteStream(value: unknown): value is NodePtyCustomWriteStream {
	if (!isObjectRecord(value)) {
		return false;
	}
	return (
		typeof value._fd === "number" &&
		Array.isArray(value._writeQueue) &&
		value._writeQueue.every(isNodePtyWriteTask) &&
		typeof value._processWriteQueue === "function"
	);
}

function isIgnorablePtyWriteError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EIO" || code === "EBADF";
}

function hasErrnoCode(error: unknown, code: string): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isIgnorablePtyResizeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EIO" || code === "EBADF") {
		return true;
	}
	return error.message.toLowerCase().includes("already exited");
}

function installNodePtyWriteErrorGuard(ptyProcess: NodePty.IPty): void {
	const writeStream = (ptyProcess as NodePtyWithWriteStream)._writeStream;
	if (!isNodePtyCustomWriteStream(writeStream)) {
		return;
	}

	// node-pty's Unix CustomWriteStream performs the real fs.write asynchronously
	// after IPty.write() returns. If the child PTY closes in that window, macOS/Linux
	// can report EIO/EBADF and node-pty logs "Unhandled pty write error" directly to
	// stderr. Keep this shim narrow: preserve EAGAIN retries, suppress only expected
	// closed-PTY errors, and keep all other write failures visible.
	writeStream._processWriteQueue = () => {
		writeStream._writeImmediate = undefined;
		const task = writeStream._writeQueue[0];
		if (!task) {
			return;
		}

		fs.write(writeStream._fd, task.buffer, task.offset, (error, written) => {
			if (error) {
				if (hasErrnoCode(error, "EAGAIN")) {
					writeStream._writeImmediate = setImmediate(() => writeStream._processWriteQueue());
					return;
				}

				writeStream._writeQueue.length = 0;
				if (!isIgnorablePtyWriteError(error)) {
					console.error("Unhandled pty write error", error);
				}
				return;
			}

			task.offset += written;
			if (task.offset >= task.buffer.byteLength) {
				writeStream._writeQueue.shift();
			}
			writeStream._processWriteQueue();
		});
	};
}

function terminatePtyProcess(ptyProcess: NodePty.IPty): void {
	const pid = ptyProcess.pid;
	ptyProcess.kill();
	if (process.platform !== "win32" && Number.isFinite(pid) && pid > 0) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// Best effort: process group may already be gone or inaccessible.
		}
	}
}

export class PtySession {
	private readonly ptyProcess: NodePty.IPty;
	private interrupted = false;
	private exited = false;
	private managedProcessOwnership: ManagedProcessOwnershipHandle | null = null;
	private managedProcessOwnershipRegistrationStarted = false;

	private constructor(
		ptyProcess: NodePty.IPty,
		private readonly onDataCallback?: (chunk: Buffer) => void,
		private readonly onExitCallback?: (event: PtyExitEvent) => void,
	) {
		this.ptyProcess = ptyProcess;
		(this.ptyProcess.onData as unknown as (listener: (data: PtyOutputChunk) => void) => void)((data) => {
			const chunk = normalizeOutputChunk(data);
			this.onDataCallback?.(chunk);
		});
		this.ptyProcess.onExit((event) => {
			this.exited = true;
			const ownership = this.managedProcessOwnership;
			this.managedProcessOwnership = null;
			if (ownership) {
				void retireManagedProcessOwnership(ownership).catch(() => undefined);
			}
			this.onExitCallback?.(event);
		});
	}

	static spawn({ binary, args = [], cwd, env, cols, rows, onData, onExit }: SpawnPtySessionRequest): PtySession {
		const normalizedArgs = typeof args === "string" ? [args] : args;
		const terminalName = env?.TERM?.trim() || process.env.TERM?.trim() || "xterm-256color";
		const launchEnv: NodeJS.ProcessEnv = env ? mergeProcessEnvironment(process.env, env) : process.env;
		preflightPtyLaunch({ binary, cwd, env: launchEnv, platform: process.platform });
		const resolvedLaunch = resolveWindowsCompatibleCommand(binary, normalizedArgs, process.platform, launchEnv);
		const spawnBinary = resolvedLaunch.binary;
		// node-pty's Windows cmd path needs one verbatim command-line string. A
		// sibling PowerShell shim is a direct executable launch and therefore keeps
		// its argv array, including embedded CR/LF prompt content, byte-for-byte.
		const spawnArgs = resolvedLaunch.commandLine ?? resolvedLaunch.args;
		const ptyOptions: NodePty.IPtyForkOptions = {
			name: terminalName,
			cwd,
			env: launchEnv,
			cols,
			rows,
			encoding: null,
		};

		let ptyProcess: NodePty.IPty;
		try {
			ptyProcess = getNodePtySpawn()(spawnBinary, spawnArgs, ptyOptions);
		} catch (error) {
			throw classifyPtySpawnFailure(error, { binary, cwd, env: launchEnv, platform: process.platform });
		}
		installNodePtyWriteErrorGuard(ptyProcess);
		return new PtySession(ptyProcess, onData, onExit);
	}

	get pid(): number {
		return this.ptyProcess.pid;
	}

	private async waitForManagedProcessPid(): Promise<number | null> {
		const deadline = Date.now() + MANAGED_PROCESS_PID_READY_TIMEOUT_MS;
		while (!this.exited) {
			const pid = this.ptyProcess.pid;
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
			if (Date.now() >= deadline) {
				throw new Error("Timed out waiting for the Windows ConPTY process identity.");
			}
			await new Promise<void>((resolveReady) => {
				const timeout = setTimeout(resolveReady, MANAGED_PROCESS_PID_POLL_MS);
				timeout.unref();
			});
		}
		return null;
	}

	/** Persist exact Windows PID identity before exposing a managed task launch. */
	async registerManagedProcessOwnership(recordId: string): Promise<void> {
		if (process.platform !== "win32" || this.exited) return;
		if (this.managedProcessOwnershipRegistrationStarted) {
			throw new Error("Managed process ownership was already registered for this PTY.");
		}
		this.managedProcessOwnershipRegistrationStarted = true;
		const pid = await this.waitForManagedProcessPid();
		if (pid === null) return;
		const ownership = await registerManagedProcessOwnership(pid, recordId);
		this.managedProcessOwnership = ownership;
		if (this.exited && ownership) {
			this.managedProcessOwnership = null;
			await retireManagedProcessOwnership(ownership);
		}
	}

	write(data: string | Buffer): void {
		try {
			this.ptyProcess.write(typeof data === "string" ? data : data.toString("utf8"));
		} catch (error) {
			if (isIgnorablePtyWriteError(error)) {
				return;
			}
			throw error;
		}
	}

	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (this.exited) {
			return;
		}
		try {
			if (pixelWidth !== undefined && pixelHeight !== undefined) {
				this.ptyProcess.resize(cols, rows, {
					width: pixelWidth,
					height: pixelHeight,
				});
				return;
			}
			this.ptyProcess.resize(cols, rows);
		} catch (error) {
			if (isIgnorablePtyResizeError(error)) {
				this.exited = true;
				return;
			}
			throw error;
		}
	}

	/** Force a TUI redraw when the requested geometry has not changed. */
	forceRedraw(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (this.exited) {
			return;
		}
		if (process.platform === "win32") {
			// Windows cannot deliver SIGWINCH to a ConPTY child. Resize to one
			// adjacent row and immediately restore the requested geometry so the
			// pseudoconsole emits a real resize notification without changing the
			// final terminal width (and therefore without reflowing long lines).
			const nudgedRows = rows === 1 ? 2 : rows - 1;
			this.resize(cols, nudgedRows, pixelWidth, pixelHeight);
			this.resize(cols, rows, pixelWidth, pixelHeight);
			return;
		}
		this.sendSignal("SIGWINCH");
	}

	sendSignal(signal: string): void {
		if (this.exited) {
			return;
		}
		try {
			process.kill(this.ptyProcess.pid, signal);
		} catch {
			// Process may already be gone.
		}
	}

	pause(): void {
		this.ptyProcess.pause();
	}

	resume(): void {
		this.ptyProcess.resume();
	}

	stop(options?: { interrupted?: boolean }): void {
		if (options?.interrupted) {
			this.interrupted = true;
		}
		terminatePtyProcess(this.ptyProcess);
	}

	wasInterrupted(): boolean {
		return this.interrupted;
	}
}
