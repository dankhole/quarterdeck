import type { RuntimeUiPreferences } from "@runtime-contract";
import type { RuntimeAppRouter } from "@runtime-trpc";
import { TRPCClientError } from "@trpc/client";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { UiPreferencesBoundary } from "@/providers/ui-preferences-boundary";
import { LocalStorageKey, removeLocalStorageItem } from "@/storage/local-storage-store";
import { sharedUiPreferences } from "@/storage/shared-ui-preferences";
import { useBooleanLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

const transport = vi.hoisted(() => ({ read: vi.fn(), patch: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			getUiPreferences: { query: transport.read },
			patchUiPreferences: { mutate: transport.patch },
		},
	}),
}));

describe("shared preference startup and mounted consumers", () => {
	it("gives restart guidance when the running runtime predates the required preference API", async () => {
		localStorage.clear();
		transport.read.mockRejectedValueOnce(
			new TRPCClientError<RuntimeAppRouter>("missing procedure", {
				result: {
					error: {
						code: -32004,
						message: "missing procedure",
						data: { code: "NOT_FOUND", httpStatus: 404, conflictRevision: null },
					},
				},
			}),
		);
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<UiPreferencesBoundary>
						<p>Mounted app</p>
					</UiPreferencesBoundary>,
				),
			);
			expect(container.textContent).toContain("Restart Quarterdeck and refresh this page");
			expect(container.textContent).not.toContain("Mounted app");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("hydrates before mounting, avoids default uploads, and updates an open preference control", async () => {
		localStorage.clear();
		let release = (_snapshot: RuntimeUiPreferences) => {};
		transport.read.mockImplementationOnce(
			() =>
				new Promise<RuntimeUiPreferences>((resolve) => {
					release = resolve;
				}),
		);
		let mounts = 0;
		function Consumer() {
			const [wrap, setWrap] = useBooleanLocalStorageValue(LocalStorageKey.FileBrowserWordWrap, true);
			useEffect(() => {
				mounts++;
			}, []);
			return (
				<button type="button" onClick={() => setWrap((value) => !value)}>
					{String(wrap)}
				</button>
			);
		}
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<UiPreferencesBoundary>
						<Consumer />
					</UiPreferencesBoundary>,
				),
			);
			expect(mounts).toBe(0);
			expect(container.textContent).toContain("Loading preferences");
			await act(async () =>
				release({
					revision: 1,
					values: { "quarterdeck.file-browser-word-wrap": false },
					collapsedProjectGroups: {},
				}),
			);
			expect(mounts).toBe(1);
			expect(container.textContent).toBe("false");
			expect(transport.patch).not.toHaveBeenCalled();
			await act(async () =>
				sharedUiPreferences.apply({
					revision: 2,
					values: { "quarterdeck.file-browser-word-wrap": true },
					collapsedProjectGroups: {},
				}),
			);
			expect(container.textContent).toBe("true");
			transport.patch.mockResolvedValueOnce({
				revision: 3,
				values: { "quarterdeck.file-browser-word-wrap": false },
				collapsedProjectGroups: {},
			});
			await act(async () => {
				container.querySelector("button")?.click();
				await sharedUiPreferences.flush();
			});
			expect(transport.patch).toHaveBeenCalledWith({
				mode: "patch",
				values: { "quarterdeck.file-browser-word-wrap": false },
			});
			expect(container.textContent).toBe("false");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("restores hook defaults when saved boolean and raw choices are reset", async () => {
		sharedUiPreferences.apply({ revision: 4, values: {}, collapsedProjectGroups: {} });
		function Consumer() {
			const [wrap, setWrap] = useBooleanLocalStorageValue(LocalStorageKey.FileBrowserWordWrap, true);
			const [action, setAction] = useRawLocalStorageValue<"start" | "start_and_open">(
				LocalStorageKey.TaskCreatePrimaryStartAction,
				"start",
				(value) => (value === "start" || value === "start_and_open" ? value : null),
			);
			return (
				<button
					type="button"
					onClick={() => {
						setWrap(false);
						setAction("start_and_open");
					}}
				>
					{String(wrap)}:{action}
				</button>
			);
		}
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () => root.render(<Consumer />));
			expect(container.textContent).toBe("true:start");
			transport.patch
				.mockResolvedValueOnce({
					revision: 5,
					values: { "quarterdeck.file-browser-word-wrap": false },
					collapsedProjectGroups: {},
				})
				.mockResolvedValueOnce({
					revision: 6,
					values: {
						"quarterdeck.file-browser-word-wrap": false,
						"quarterdeck.task-create-primary-start-action": "start_and_open",
					},
					collapsedProjectGroups: {},
				});
			await act(async () => {
				container.querySelector("button")?.click();
				await sharedUiPreferences.flush();
			});
			expect(container.textContent).toBe("false:start_and_open");
			transport.patch
				.mockResolvedValueOnce({
					revision: 7,
					values: {
						"quarterdeck.file-browser-word-wrap": null,
						"quarterdeck.task-create-primary-start-action": "start_and_open",
					},
					collapsedProjectGroups: {},
				})
				.mockResolvedValueOnce({
					revision: 8,
					values: {
						"quarterdeck.file-browser-word-wrap": null,
						"quarterdeck.task-create-primary-start-action": null,
					},
					collapsedProjectGroups: {},
				});
			await act(async () => {
				removeLocalStorageItem(LocalStorageKey.FileBrowserWordWrap);
				removeLocalStorageItem(LocalStorageKey.TaskCreatePrimaryStartAction);
				await sharedUiPreferences.flush();
			});
			expect(container.textContent).toBe("true:start");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
