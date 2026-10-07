import { describe, expect, it, vi } from "vitest";
import { resolveDesktopFrontendPreflightReason } from "../../../../desktop/src/desktop-preflight-reason";
import { DesktopQuitCoordinator, type DesktopQuitOptions } from "../../../../desktop/src/quit-coordinator";
import type { DesktopQuitPreflightResponse } from "../../../../src/shared/desktop-bridge-contract";
import {
	clearCachedFileEditorTabs,
	getFileEditorDrafts,
	registerFileEditorScope,
	setCachedFileEditorTabs,
	setFileEditorRecoveryStatus,
} from "../git/file-editor-cache";
import {
	connectFileEditorRecoveryStorage,
	flushFileEditorRecoveryStorage,
	getFileEditorRecoveryCommitStatus,
	retryFileEditorRecoveryStorage,
} from "../git/file-editor-recovery-storage";
import { createFileEditorTab } from "../git/file-editor-workspace";
import { resolveDesktopQuitPreflight } from "./desktop-app";

/** Composes the actual main reason adapter, renderer draft veto, and native cleanup authority. */
function fixture(initial: "running" | "clean" | "unconfirmed", dirty = false, recoveryReady = () => true) {
	let cleanup = initial;
	let connected = initial === "running";
	let request = 0;
	let validSeal: string | null = null;
	const reasons: string[] = [];
	const responses: (DesktopQuitPreflightResponse | null)[] = [];
	const preflight: DesktopQuitOptions["preflight"] = async (reason, seal) => {
		const frontendReason = resolveDesktopFrontendPreflightReason(reason, cleanup);
		reasons.push(frontendReason);
		const response = resolveDesktopQuitPreflight(
			{ requestId: `request-${++request}`, runtimeGeneration: "generation", reason: frontendReason },
			"generation",
			{
				dirtyEditorCount: dirty ? 1 : 0,
				activeSessionCount: 0,
				needsInputSessionCount: 0,
				runtimeConnected: connected,
			},
			recoveryReady(),
		);
		responses.push(response);
		if (seal && response?.decision === "ready") validSeal = response.requestId;
		return response;
	};
	const options: DesktopQuitOptions = {
		needsFrontendPreflight: () => true,
		cleanupState: () => cleanup,
		preflight,
		isSealValid: (response: DesktopQuitPreflightResponse) => response.requestId === validSeal,
		releasePreflight: vi.fn(() => {
			validSeal = null;
		}),
		getSummary: vi.fn<DesktopQuitOptions["getSummary"]>(async () => ({
			method: "get-quit-summary",
			owned: true,
			liveProcessCount: 0,
			pendingLaunches: false,
		})),
		stop: vi.fn<DesktopQuitOptions["stop"]>(async () => {
			cleanup = "clean";
			connected = false;
			validSeal = null;
			return { status: "clean", safeToExit: true, safeToReleaseOwnership: true };
		}),
		confirmSessions: vi.fn(async () => true),
		confirmUnconfirmedExit: vi.fn(async () => true),
		canForceExit: () => false,
		inform: vi.fn(async () => undefined),
		onStopping: vi.fn(),
	};
	return { owner: new DesktopQuitCoordinator(options), options, reasons, responses };
}

describe("clean-stop update preflight composition", () => {
	it("renews an expired renderer seal after main proves a clean runtime stop", async () => {
		const { owner, options, reasons } = fixture("running");
		expect(await owner.request("update")).toEqual({ kind: "clean" });
		expect(reasons).toEqual(["update", "update", "quit"]);
		expect(options.stop).toHaveBeenCalledOnce();
	});
	it("permits a later installer retry with a clean stopped runtime", async () => {
		const { owner, options, reasons } = fixture("clean");
		expect(await owner.request("update")).toEqual({ kind: "clean" });
		expect(reasons).toEqual(["quit", "quit", "quit"]);
		expect(options.getSummary).not.toHaveBeenCalled();
	});
	it("retains the offline renderer draft veto after the clean-stop mapping", async () => {
		const { owner, options, reasons } = fixture("clean", true);
		expect(await owner.request("update")).toEqual({ kind: "cancelled" });
		expect(reasons).toEqual(["quit"]);
		expect(options.stop).not.toHaveBeenCalled();
	});
	it("cannot map unconfirmed cleanup into an offline update permission", async () => {
		const { owner, options, reasons } = fixture("unconfirmed");
		expect(await owner.request("update")).toEqual({ kind: "cancelled" });
		expect(reasons).toEqual(["update"]);
		expect(options.stop).not.toHaveBeenCalled();
		expect(options.confirmUnconfirmedExit).not.toHaveBeenCalled();
	});
	it.each(["pending", "failed"] as const)(
		"requires a recovery commit before zero-dirty forced Quit when pruning is %s",
		async (state) => {
			const storage = { read: vi.fn(async () => undefined), write: vi.fn(async (_raw: string) => {}) };
			const dispose = connectFileEditorRecoveryStorage(storage);
			let acknowledge!: () => void;
			let abort!: (error: Error) => void;
			try {
				const tab = {
					...createFileEditorTab("saved.ts", {
						content: "original",
						contentHash: "hash",
						language: "typescript",
						binary: false,
						truncated: false,
						size: 8,
					}),
					value: "saved source edit",
				};
				registerFileEditorScope("project:home", { projectId: "project", taskId: null, rootPath: "/fixture" });
				setCachedFileEditorTabs("project:home", [tab]);
				expect(await flushFileEditorRecoveryStorage(storage)).toBe(true);
				await Promise.resolve();
				const commit = new Promise<void>((resolve, reject) => {
					acknowledge = resolve;
					abort = reject;
				});
				storage.write.mockImplementation(async () => commit);
				setCachedFileEditorTabs("project:home", [{ ...tab, savedValue: tab.value }]);
				// This synchronous mutation must revoke readiness before any async write starts.
				expect(getFileEditorDrafts("all")).toHaveLength(0);
				expect(getFileEditorRecoveryCommitStatus(storage).ready).toBe(false);
				if (state === "failed") {
					abort(new Error("strict transaction aborted"));
					expect(await flushFileEditorRecoveryStorage(storage)).toBe(false);
				}
				const { owner, options, responses } = fixture(
					"unconfirmed",
					false,
					() => getFileEditorRecoveryCommitStatus(storage).ready,
				);
				options.canForceExit = () => true;
				options.finalize = vi.fn(async () => {});
				expect(await owner.request("quit")).toEqual({ kind: "cancelled" });
				expect(options.confirmUnconfirmedExit).toHaveBeenCalledOnce();
				expect(responses).toHaveLength(2);
				for (const response of responses)
					expect(response).toMatchObject({ decision: "blocked", status: { dirtyEditorCount: 0 } });
				expect(options.stop).not.toHaveBeenCalled();
				expect(options.finalize).not.toHaveBeenCalled();
				storage.write.mockImplementation(async () => {});
				if (state === "pending") {
					acknowledge();
					expect(await flushFileEditorRecoveryStorage(storage)).toBe(true);
				} else expect(await retryFileEditorRecoveryStorage(storage)).toBe(true);
				await Promise.resolve();
				expect(await owner.request("quit")).toEqual({ kind: "forced", cleanup: "unconfirmed" });
				expect(options.finalize).toHaveBeenCalledOnce();
			} finally {
				acknowledge?.();
				dispose();
				clearCachedFileEditorTabs();
				setFileEditorRecoveryStatus(null, 0);
			}
		},
	);
});
