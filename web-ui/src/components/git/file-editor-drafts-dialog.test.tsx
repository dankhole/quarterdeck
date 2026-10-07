import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRuntimeBoundary } from "@/components/app/app-runtime-boundary";
import { showAppToast } from "@/components/app-toaster";
import {
	clearCachedFileEditorTabs,
	getFileEditorDrafts,
	getFileEditorReviewTarget,
	registerFileEditorScope,
	setCachedFileEditorTabs,
	setFileEditorRecoveryStatus,
	setFileEditorReviewTarget,
} from "@/hooks/git/file-editor-cache";
import { exportFileEditorDraft } from "@/hooks/git/file-editor-draft-export";
import type { FileEditorRecoveryCommitStatus } from "@/hooks/git/file-editor-recovery-storage";
import { createFileEditorTab } from "@/hooks/git/file-editor-workspace";
import { FileEditorDraftsDialog } from "./file-editor-drafts-dialog";

const recoveryMock = vi.hoisted(() => ({
	kind: "desktop" as "desktop" | "browser",
	status: {
		loaded: true,
		pending: false,
		busy: false,
		problem: null,
		desiredRevision: 0,
		committedRevision: 0,
		ready: true,
	} as FileEditorRecoveryCommitStatus,
	retry: vi.fn<() => Promise<boolean>>(),
	reset: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("@/hooks/git/use-desktop-file-editor-recovery", () => ({
	useDesktopFileEditorRecovery: () => ({
		commitStatus: recoveryMock.status,
		retryRecovery: recoveryMock.retry,
		resetRecovery: recoveryMock.reset,
	}),
}));
vi.mock("@/hooks/git/file-editor-draft-export", () => ({ exportFileEditorDraft: vi.fn() }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));
vi.mock("@/runtime/runtime-environment", () => ({ getRuntimeEnvironment: () => ({ kind: recoveryMock.kind }) }));
vi.mock("@/providers/project-provider", () => ({
	useProjectRuntimeStreamContext: () => ({ isRuntimeDisconnected: true, streamError: "Connection lost" }),
}));
vi.mock("@/providers/project-runtime-provider", () => ({
	useProjectRuntimeContext: () => ({ isQuarterdeckAccessBlocked: false }),
}));

describe("offline desktop draft review", () => {
	let root: Root;
	let container: HTMLDivElement;
	function render(): void {
		root.render(
			<>
				<AppRuntimeBoundary>
					<input aria-label="Local task draft" />
				</AppRuntimeBoundary>
				<FileEditorDraftsDialog />
			</>,
		);
	}
	function setRecoveryStatus(status: Partial<FileEditorRecoveryCommitStatus>): void {
		recoveryMock.status = { ...recoveryMock.status, ...status };
		setFileEditorRecoveryStatus(
			recoveryMock.status.problem,
			0,
			false,
			recoveryMock.status.pending,
			recoveryMock.status.busy,
		);
		render();
	}
	beforeEach(async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		recoveryMock.kind = "desktop";
		recoveryMock.status = {
			loaded: true,
			pending: false,
			busy: false,
			problem: null,
			desiredRevision: 0,
			committedRevision: 0,
			ready: true,
		};
		recoveryMock.retry.mockReset().mockResolvedValue(true);
		recoveryMock.reset.mockReset().mockResolvedValue(true);
		setFileEditorRecoveryStatus(null, 0);
		registerFileEditorScope("home", { projectId: "project", taskId: null, rootPath: "/synthetic/project" });
		const tab = createFileEditorTab("draft.ts", {
			content: "saved",
			contentHash: "hash",
			language: "typescript",
			binary: false,
			truncated: false,
			size: 5,
		});
		setCachedFileEditorTabs("home", [{ ...tab, value: "Complete unsaved contents" }]);
		setFileEditorReviewTarget("all");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => render());
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		clearCachedFileEditorTabs();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});
	function button(label: string): HTMLButtonElement {
		const result = [...document.querySelectorAll("button")].find((element) => element.textContent === label);
		if (!result) throw new Error(`Missing button ${label}`);
		return result;
	}
	it("names the portaled dialog and contents, preserves text on Escape, and never makes the document inert", async () => {
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(document.querySelector("dialog")).toBeNull();
		expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Unsaved files");
		expect(dialog.getAttribute("aria-describedby")).toBe("file-editor-drafts-description");
		const text = document.querySelector<HTMLTextAreaElement>('[aria-label="Unsaved contents of draft.ts"]')!;
		text.focus();
		expect(document.activeElement).toBe(text);
		expect(text.readOnly).toBe(true);
		expect(text.value).toBe("Complete unsaved contents");
		await act(async () => text.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(getFileEditorReviewTarget()).toBeNull();
		expect(getFileEditorDrafts("all")[0]?.tab.value).toBe("Complete unsaved contents");
	});
	it("requires explicit confirmation to discard and permits keeping the draft", () => {
		act(() => button("Discard draft…").click());
		expect(document.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Discard draft draft.ts");
		act(() => button("Keep draft").click());
		expect(getFileEditorDrafts("all")).toHaveLength(1);
		act(() => button("Discard draft…").click());
		act(() => button("Confirm discard").click());
		expect(getFileEditorDrafts("all")).toHaveLength(0);
	});
	it("announces a pending native save and retains complete text after failure", async () => {
		let finish: ((outcome: "failed") => void) | undefined;
		vi.mocked(exportFileEditorDraft).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		act(() => button("Save draft…").click());
		expect(button("Save draft…").getAttribute("aria-busy")).toBe("true");
		expect(button("Save draft…").disabled).toBe(true);
		await act(async () => finish?.("failed"));
		expect(showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "danger" }));
		expect(getFileEditorDrafts("all")[0]?.tab.value).toBe("Complete unsaved contents");
	});
	it("keeps one global desktop status marker when no drafts or dialog are visible", () => {
		act(() => {
			clearCachedFileEditorTabs();
			setFileEditorReviewTarget(null);
			setRecoveryStatus({ loaded: false, pending: true, ready: false });
		});
		const marker = () => document.querySelector('[data-testid="file-editor-recovery-status"]');
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(marker()?.getAttribute("data-state")).toBe("loading");
		act(() => setRecoveryStatus({ loaded: true, pending: true }));
		expect(marker()?.getAttribute("data-state")).toBe("pending");
		act(() => setRecoveryStatus({ loaded: false, problem: "storage" }));
		expect(marker()?.getAttribute("data-state")).toBe("error");
		act(() => setRecoveryStatus({ loaded: true, pending: false, problem: null, ready: true }));
		expect(marker()?.getAttribute("data-state")).toBe("ready");
		act(() => setFileEditorReviewTarget("all"));
		expect(document.querySelectorAll('[data-testid="file-editor-recovery-status"]')).toHaveLength(1);
		expect(marker()?.closest('[role="dialog"]')).toBeNull();
	});
	it("does not expose the desktop recovery marker in a browser", () => {
		recoveryMock.kind = "browser";
		act(() => root.render(<FileEditorDraftsDialog />));
		expect(document.querySelector('[data-testid="file-editor-recovery-status"]')).toBeNull();
		expect(button("Download draft")).toBeDefined();
	});
	it("disables recovery actions only during physical work and permits retry of a failed revision", () => {
		act(() => setRecoveryStatus({ problem: "storage", pending: true, busy: true, ready: false }));
		expect(button("Retry recovery").disabled).toBe(true);
		expect(button("Reset saved recovery…").disabled).toBe(true);
		act(() => setRecoveryStatus({ busy: false }));
		expect(button("Retry recovery").disabled).toBe(false);
		expect(button("Reset saved recovery…").disabled).toBe(false);
		expect(document.querySelector('[data-testid="file-editor-recovery-status"]')?.getAttribute("data-state")).toBe(
			"error",
		);
	});
	it.each(["failed", "rejected"] as const)(
		"keeps Retry usable and drafts intact after a %s asynchronous retry",
		async (outcome) => {
			let resolve: ((result: boolean) => void) | undefined;
			let reject: ((reason: Error) => void) | undefined;
			recoveryMock.retry.mockImplementationOnce(
				() =>
					new Promise<boolean>((finish, fail) => {
						resolve = finish;
						reject = fail;
					}),
			);
			act(() => setRecoveryStatus({ problem: "storage", pending: true, ready: false }));
			act(() => button("Retry recovery").click());
			expect(button("Retrying recovery…").disabled).toBe(true);
			expect(button("Retrying recovery…").getAttribute("aria-busy")).toBe("true");
			expect(button("Reset saved recovery…").disabled).toBe(true);
			act(() => button("Retrying recovery…").click());
			expect(recoveryMock.retry).toHaveBeenCalledTimes(1);
			await act(async () => {
				if (outcome === "failed") resolve?.(false);
				else reject?.(new Error("Synthetic storage failure"));
			});
			expect(button("Retry recovery").disabled).toBe(false);
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"Quit, reload, and update are blocked until recovery storage is ready",
			);
			expect(getFileEditorDrafts("all")[0]?.tab.value).toBe("Complete unsaved contents");
			expect(showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "danger" }));
			await act(async () => button("Retry recovery").click());
			expect(recoveryMock.retry).toHaveBeenCalledTimes(2);
		},
	);
	it.each(["failed", "rejected"] as const)(
		"keeps reset confirmation until an ACK after a %s reset",
		async (outcome) => {
			let resolve: ((result: boolean) => void) | undefined;
			let reject: ((reason: Error) => void) | undefined;
			recoveryMock.reset.mockImplementationOnce(
				() =>
					new Promise<boolean>((finish, fail) => {
						resolve = finish;
						reject = fail;
					}),
			);
			act(() => setRecoveryStatus({ problem: "storage", pending: true, ready: false }));
			act(() => button("Reset saved recovery…").click());
			act(() => button("Confirm reset").click());
			expect(button("Resetting recovery…").disabled).toBe(true);
			expect(button("Resetting recovery…").getAttribute("aria-busy")).toBe("true");
			expect(button("Keep saved recovery").disabled).toBe(true);
			expect(button("Retry recovery").disabled).toBe(true);
			await act(async () => {
				if (outcome === "failed") resolve?.(false);
				else reject?.(new Error("Synthetic storage failure"));
			});
			expect(button("Confirm reset").disabled).toBe(false);
			expect(button("Keep saved recovery").disabled).toBe(false);
			expect(document.querySelector('[role="alert"]')).not.toBeNull();
			expect(getFileEditorDrafts("all")[0]?.tab.value).toBe("Complete unsaved contents");
			expect(showAppToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "danger" }));
			await act(async () => button("Confirm reset").click());
			expect(
				[...document.querySelectorAll("button")].some((element) => element.textContent === "Confirm reset"),
			).toBe(false);
			expect(recoveryMock.reset).toHaveBeenCalledTimes(2);
			expect(getFileEditorDrafts("all")[0]?.tab.value).toBe("Complete unsaved contents");
		},
	);
});
