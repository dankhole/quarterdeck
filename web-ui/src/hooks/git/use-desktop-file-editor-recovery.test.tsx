import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const environment = vi.hoisted(() => ({ kind: "browser" }));
const database = vi.hoisted(() => {
	const state = { raw: undefined as string | undefined, commit: Promise.resolve() };
	const adapter = {
		read: vi.fn(async () => state.raw),
		write: vi.fn(async (raw: string) => {
			await state.commit;
			state.raw = raw;
		}),
		close: vi.fn(),
	};
	return { state, adapter, create: vi.fn(() => adapter) };
});
vi.mock("@/runtime/runtime-environment", () => ({ getRuntimeEnvironment: () => environment }));
vi.mock("./file-editor-recovery-indexed-db", () => ({ createFileEditorRecoveryIndexedDB: database.create }));

import { clearCachedFileEditorTabs, getFileEditorDrafts, setFileEditorRecoveryStatus } from "./file-editor-cache";
import { encodeFileEditorRecovery, FILE_EDITOR_RECOVERY_KEY } from "./file-editor-recovery";
import { createFileEditorTab } from "./file-editor-workspace";
import { useDesktopFileEditorRecovery } from "./use-desktop-file-editor-recovery";

function Harness() {
	const { commitStatus } = useDesktopFileEditorRecovery();
	return <span>{commitStatus.ready ? "ready" : "pending"}</span>;
}
afterEach(() => {
	vi.restoreAllMocks();
	clearCachedFileEditorTabs();
	setFileEditorRecoveryStatus(null, 0);
	localStorage.clear();
});
describe("desktop-only recovery adapter", () => {
	it("does not read or write recovery storage in a browser client", async () => {
		environment.kind = "browser";
		const read = vi.spyOn(Storage.prototype, "getItem");
		const write = vi.spyOn(Storage.prototype, "setItem");
		const node = document.createElement("div");
		const root = createRoot(node);
		await act(async () => {
			root.render(<Harness />);
		});
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(database.create).not.toHaveBeenCalled();
		expect(database.adapter.read).not.toHaveBeenCalled();
		await act(async () => {
			root.unmount();
		});
	});
	it("hydrates legacy text before committing and keeps one writer through a hook remount", async () => {
		environment.kind = "desktop";
		let acknowledge!: () => void;
		database.state.commit = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		const result = encodeFileEditorRecovery(
			[
				{
					id: "draft",
					scopeKey: "p:home",
					generation: 1,
					scope: { projectId: "p", taskId: null, rootPath: "/repo" },
					detached: false,
					tab: {
						...createFileEditorTab("a.ts", {
							content: "saved",
							contentHash: "hash",
							language: "typescript",
							binary: false,
							truncated: false,
							size: 5,
						}),
						value: "recovery",
					},
				},
			],
			[],
			Date.now(),
		);
		if (!result.ok) throw new Error("Invalid fixture");
		localStorage.setItem(FILE_EDITOR_RECOVERY_KEY, result.raw);
		const node = document.createElement("div");
		let root = createRoot(node);
		await act(async () => {
			root.render(<Harness />);
		});
		expect(getFileEditorDrafts("detached")[0]).toMatchObject({
			recovered: true,
			tab: { value: "recovery", recoveryRequiresSave: true },
		});
		expect(node.textContent).toBe("pending");
		expect(database.adapter.write).toHaveBeenCalledOnce();
		expect(localStorage.getItem(FILE_EDITOR_RECOVERY_KEY)).toBe(result.raw);
		await act(async () => {
			root.unmount();
		});
		root = createRoot(node);
		await act(async () => {
			root.render(<Harness />);
		});
		expect(database.create).toHaveBeenCalledOnce();
		expect(database.adapter.read).toHaveBeenCalledOnce();
		expect(database.adapter.write).toHaveBeenCalledOnce();
		expect(database.adapter.close).not.toHaveBeenCalled();
		await act(async () => {
			acknowledge();
		});
		expect(node.textContent).toBe("ready");
		expect(database.state.raw).toBe(result.raw);
		expect(localStorage.getItem(FILE_EDITOR_RECOVERY_KEY)).toBeNull();
		await act(async () => root.unmount());
	});
});
