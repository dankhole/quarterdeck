import type { DesktopControlResultMessage } from "../../src/core/api/desktop-runtime-protocol.js";
import type { RuntimeShutdownOutcome } from "../../src/core/api/runtime-shutdown.js";
import type { DesktopQuitPreflightResponse } from "../../src/shared/desktop-bridge-contract.js";

export type DesktopQuitReason = "quit" | "restart" | "update";
export type DesktopQuitResult = { kind: "clean" } | { kind: "forced"; cleanup: "unconfirmed" } | { kind: "cancelled" };
export type DesktopQuitSummary = Extract<DesktopControlResultMessage["result"], { method: "get-quit-summary" }>;

export interface DesktopQuitOptions {
	needsFrontendPreflight: () => boolean;
	cleanupState: () => "not_started" | "running" | "clean" | "unconfirmed";
	preflight: (reason: DesktopQuitReason, seal?: boolean) => Promise<DesktopQuitPreflightResponse | null>;
	isSealValid: (response: DesktopQuitPreflightResponse) => boolean;
	releasePreflight: () => void;
	getSummary: () => Promise<DesktopQuitSummary | null>;
	stop: () => Promise<RuntimeShutdownOutcome>;
	confirmSessions: (summary: DesktopQuitSummary, reason: DesktopQuitReason) => Promise<boolean>;
	confirmUnconfirmedExit: () => Promise<boolean>;
	inform: (reason: "frontend_unavailable" | "runtime_unavailable" | "shutdown_incomplete") => Promise<void>;
	onStopping: (stopping: boolean) => void;
	finalize?: (result: Exclude<DesktopQuitResult, { kind: "cancelled" }>, reason: DesktopQuitReason) => Promise<void>;
}

/** One lease protects drafts and app-owned sessions across Quit and runtime restart. */
export class DesktopQuitCoordinator {
	private pending: Promise<DesktopQuitResult> | null = null;
	private pendingReason: DesktopQuitReason | null = null;
	private normalQuitPending = false;
	private lastSeal: DesktopQuitPreflightResponse | true | null = null;

	constructor(private readonly options: DesktopQuitOptions) {}

	isNormalQuitPending(): boolean {
		return this.normalQuitPending;
	}

	isPending(): boolean {
		return this.pending !== null;
	}

	cancelNormalQuit(): void {
		this.normalQuitPending = false;
	}

	request(reason: DesktopQuitReason, commitCleanUpdate?: () => Promise<void>): Promise<DesktopQuitResult> {
		// An update owns a distinct clean-only transaction. Another transition cannot borrow its result or commit.
		if (this.pending && (reason === "update" || this.pendingReason === "update"))
			return Promise.resolve({ kind: "cancelled" });
		if (reason === "quit") this.normalQuitPending = true;
		if (this.pending) return this.pending;
		this.pendingReason = reason;
		this.pending = this.perform(reason)
			.catch(async () => {
				try {
					await this.options.inform("shutdown_incomplete");
				} catch {
					/* Presentation cannot authorize exit. */
				}
				return { kind: "cancelled" } as const;
			})
			.then(async (result) => {
				// The clean stop is authoritative. Later seals protect drafts while the renderer is offline;
				// the initial update preflight still requires the frontend's connected-runtime check.
				const finalSealReason = reason === "update" && result.kind === "clean" ? "quit" : reason;
				if (result.kind !== "cancelled" && this.options.finalize) {
					try {
						await this.options.finalize(result, reason);
					} catch {
						/* Evidence cannot reverse verified process cleanup. */
					}
					if (
						this.lastSeal !== true &&
						(!this.lastSeal || !this.options.isSealValid(this.lastSeal)) &&
						!(await this.sealFrontend(finalSealReason))
					)
						result = { kind: "cancelled" };
				}
				if (reason === "update" && result.kind === "clean" && commitCleanUpdate) {
					try {
						// Authorization follows verified cleanup and the final draft seal, while the quit lease is held.
						if (!(await this.sealFrontend(finalSealReason))) result = { kind: "cancelled" };
						else {
							await commitCleanUpdate();
							if (!(await this.ensureSeal(finalSealReason))) result = { kind: "cancelled" };
						}
					} catch {
						result = { kind: "cancelled" };
					}
				}
				if (result.kind === "cancelled") this.options.releasePreflight();
				return result;
			})
			.finally(() => {
				this.options.onStopping(false);
				this.pending = null;
				this.pendingReason = null;
			});
		return this.pending;
	}

	private async perform(reason: DesktopQuitReason): Promise<DesktopQuitResult> {
		const cleanup = this.options.cleanupState();
		if (this.options.needsFrontendPreflight()) {
			const frontend = await this.options.preflight(reason);
			if (!frontend) {
				await this.options.inform("frontend_unavailable");
				return { kind: "cancelled" };
			}
			if (
				frontend.decision !== "ready" &&
				!(cleanup === "unconfirmed" && reason === "quit" && frontend.status.dirtyEditorCount === 0)
			)
				return { kind: "cancelled" };
		}
		if (cleanup === "unconfirmed") {
			if (reason === "quit") return await this.forceQuit();
			return { kind: "cancelled" };
		}
		if (cleanup === "running") {
			const summary = await this.options.getSummary();
			if (!summary) {
				await this.options.inform("runtime_unavailable");
				return { kind: "cancelled" };
			}
			if (
				summary.owned &&
				(summary.liveProcessCount > 0 || summary.pendingLaunches) &&
				!(await this.options.confirmSessions(summary, reason))
			)
				return { kind: "cancelled" };
		}
		// Recheck after asynchronous native confirmation; the frontend holds its transition lease until cancellation/commit.
		const seal = await this.sealFrontend(reason);
		if (!seal) return { kind: "cancelled" };
		this.options.onStopping(true);
		const outcome = await this.options.stop();
		if (outcome.status === "clean") {
			if (
				seal !== true &&
				!this.options.isSealValid(seal) &&
				!(await this.sealFrontend(reason === "update" ? "quit" : reason))
			)
				return { kind: "cancelled" };
			return { kind: "clean" };
		}
		// An explicit normal-quit escape is available only after the owned helper is gone.
		if (reason === "quit" && this.options.cleanupState() === "unconfirmed") return await this.forceQuit();
		await this.options.inform("shutdown_incomplete");
		return { kind: "cancelled" };
	}

	private async forceQuit(): Promise<DesktopQuitResult> {
		if (!(await this.options.confirmUnconfirmedExit())) return { kind: "cancelled" };
		if (!(await this.sealFrontend("quit"))) return { kind: "cancelled" };
		return { kind: "forced", cleanup: "unconfirmed" };
	}

	private async ensureSeal(reason: DesktopQuitReason): Promise<boolean> {
		return (
			this.lastSeal === true ||
			(this.lastSeal !== null && this.options.isSealValid(this.lastSeal)) ||
			Boolean(await this.sealFrontend(reason))
		);
	}

	private async sealFrontend(reason: DesktopQuitReason): Promise<DesktopQuitPreflightResponse | true | null> {
		if (!this.options.needsFrontendPreflight()) {
			this.lastSeal = true;
			return true;
		}
		const response = await this.options.preflight(reason, true);
		this.lastSeal = response?.decision === "ready" && this.options.isSealValid(response) ? response : null;
		return this.lastSeal;
	}
}
