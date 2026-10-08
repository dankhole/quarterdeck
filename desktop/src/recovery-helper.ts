import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import type { DesktopRuntimeLaunchConfig } from "./launch-config.js";
import { sanitizeDesktopHelperEnvironment } from "./launch-environment.js";
import type { RuntimeBundle } from "./runtime-bundle.js";

export type DesktopRecoveryHelperResult = "recovered" | "failed" | "timed_out" | "unavailable";

export interface DesktopRecoveryHelperOptions {
	bundle: RuntimeBundle;
	launch: DesktopRuntimeLaunchConfig;
	environment: NodeJS.ProcessEnv;
	deadlineMs?: number;
	terminationDeadlineMs?: number;
	spawnChild?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
}

interface RecoveryChild {
	exited: boolean;
	exit: Promise<number | null>;
}

/** Fixed maintenance command only; timeout cleanup targets this newly spawned child, never saved PIDs. */
export class DesktopRecoveryHelper {
	private active: RecoveryChild | null = null;

	constructor(private readonly options: DesktopRecoveryHelperOptions) {}

	isRunning(): boolean {
		return this.active !== null && !this.active.exited;
	}

	async run(): Promise<DesktopRecoveryHelperResult> {
		if (this.isRunning()) return "unavailable";
		const { bundle, launch } = this.options;
		let child: ChildProcess;
		try {
			const environment = sanitizeDesktopHelperEnvironment(this.options.environment, bundle.nodePath);
			delete environment.QUARTERDECK_DESKTOP_CHILD;
			delete environment.QUARTERDECK_DESKTOP_LAB_CONFIG;
			delete environment.QUARTERDECK_AGENT_LAB;
			child = (this.options.spawnChild ?? spawn)(bundle.nodePath, [bundle.cliPath, "recover", "--confirm-stopped"], {
				cwd: bundle.root,
				env: { ...environment, QUARTERDECK_STATE_HOME: launch.stateHome },
				stdio: ["ignore", "ignore", "ignore"],
				shell: false,
				detached: false,
			});
		} catch {
			return "failed";
		}
		let resolveExit: (code: number | null) => void = () => undefined;
		const current: RecoveryChild = {
			exited: false,
			exit: new Promise((resolve) => {
				resolveExit = resolve;
			}),
		};
		this.active = current;
		child.once("exit", (code) => {
			current.exited = true;
			resolveExit(code);
		});
		child.on("error", () => {
			if (!child.pid) {
				current.exited = true;
				resolveExit(null);
			}
		});
		const result = await this.waitForExit(current, this.options.deadlineMs ?? 15_000);
		if (result.exited) return result.code === 0 ? "recovered" : "failed";
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			if (current.exited) break;
			try {
				child.kill(signal);
			} catch {
				/* Keep the helper fenced until its actual exit is observed. */
			}
			const stopped = await this.waitForExit(current, this.options.terminationDeadlineMs ?? 1_000);
			if (stopped.exited) break;
		}
		return "timed_out";
	}

	private async waitForExit(
		current: RecoveryChild,
		deadlineMs: number,
	): Promise<{ exited: true; code: number | null } | { exited: false }> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				current.exit.then((code) => ({ exited: true as const, code })),
				new Promise<{ exited: false }>((resolve) => {
					timer = setTimeout(() => resolve({ exited: false }), deadlineMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}
