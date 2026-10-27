import type { RuntimeUiPreferences } from "@runtime-contract";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiPreferencesBoundary } from "@/providers/ui-preferences-boundary";
import { LocalStorageKey, writeLocalStorageItem } from "@/storage/local-storage-store";
import * as preferences from "@/storage/shared-ui-preferences";

const transport = vi.hoisted(() => ({ read: vi.fn(), patch: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: { getUiPreferences: { query: transport.read }, patchUiPreferences: { mutate: transport.patch } },
	}),
}));

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
});

describe("read-only preference startup", () => {
	it("hydrates a fresh viewer by query only, never collecting or seeding legacy values", async () => {
		expect(preferences.sharedUiPreferences.active).toBe(false);
		localStorage.clear();
		localStorage.setItem(LocalStorageKey.FileBrowserWordWrap, "true");
		localStorage.setItem("quarterdeck.project-groups-collapsed.org-1", '["ungrouped"]');
		const collect = vi.spyOn(preferences, "collectLegacyUiPreferences");
		const initialize = vi.spyOn(preferences.sharedUiPreferences, "initialize");
		let release!: (snapshot: RuntimeUiPreferences) => void;
		transport.read.mockImplementationOnce(
			() =>
				new Promise<RuntimeUiPreferences>((resolve) => {
					release = resolve;
				}),
		);
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<UiPreferencesBoundary readOnly>
						<p>Mounted viewer</p>
					</UiPreferencesBoundary>,
				),
			);
			expect(container.textContent).toContain("Loading preferences");
			expect(container.textContent).not.toContain("Mounted viewer");
			await act(async () =>
				release({
					revision: 1,
					values: { "quarterdeck.file-browser-word-wrap": false },
					collapsedProjectGroups: {},
				}),
			);
			expect(container.textContent).toContain("Mounted viewer");
			expect(transport.read).toHaveBeenCalledOnce();
			expect(collect).not.toHaveBeenCalled();
			expect(initialize).not.toHaveBeenCalled();
			expect(transport.patch).not.toHaveBeenCalled();
			writeLocalStorageItem(LocalStorageKey.FileBrowserWordWrap, "true");
			preferences.sharedUiPreferences.writeCollapsedGroups("org-1", ["ungrouped"]);
			await preferences.sharedUiPreferences.flush();
			expect(transport.patch).not.toHaveBeenCalled();
			expect(preferences.sharedUiPreferences.read(LocalStorageKey.FileBrowserWordWrap)).toBe("false");
			expect(preferences.sharedUiPreferences.readCollapsedGroups("org-1")).toEqual([]);
		} finally {
			await act(async () => root.unmount());
		}
	});
});
