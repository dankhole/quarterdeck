import type { RuntimeUiPreferences } from "@runtime-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectLegacyUiPreferences, SharedUiPreferencesStore } from "./shared-ui-preferences";

const empty: RuntimeUiPreferences = { revision: 0, values: {}, collapsedProjectGroups: {} };
const key = "quarterdeck.file-browser-word-wrap";

describe("browser shared UI preferences", () => {
	beforeEach(() => localStorage.clear());

	it("does not upload defaults for a fresh browser or disabled storage", async () => {
		const patch = vi.fn();
		for (const storage of [localStorage, null]) {
			const store = new SharedUiPreferencesStore();
			await store.initialize({ read: async () => empty, patch }, collectLegacyUiPreferences(storage), vi.fn());
			expect(store.read(key)).toBeNull();
		}
		expect(patch).not.toHaveBeenCalled();
	});

	it("hydrates a read-only viewer without installing a write transport or staging local changes", async () => {
		const store = new SharedUiPreferencesStore();
		const read = vi.fn().mockResolvedValue({ ...empty, revision: 1, values: { [key]: false } });
		await store.initializeReadOnly({ read });
		expect(read).toHaveBeenCalledOnce();
		expect(store.active).toBe(true);
		expect(store.read(key)).toBe("false");
		store.write(key, "true");
		store.writeCollapsedGroups("org-1", ["ungrouped"]);
		store.writeGitView("task-a", { activeTab: "compare" });
		await store.flush();
		expect(store.read(key)).toBe("false");
		expect(store.readCollapsedGroups("org-1")).toEqual([]);
		expect(store.readGitView("task-a")).toEqual({});
		store.apply({ ...empty, revision: 2, values: { [key]: true } });
		expect(store.read(key)).toBe("true");
	});

	it("removes any prior write transport when initialized for a read-only viewer", async () => {
		const store = new SharedUiPreferencesStore();
		const patch = vi.fn();
		await store.initialize({ read: async () => empty, patch }, collectLegacyUiPreferences(null), vi.fn());
		await store.initializeReadOnly({ read: async () => empty });
		store.write(key, "true");
		store.writeCollapsedGroups("org-1", ["ungrouped"]);
		await store.flush();
		expect(patch).not.toHaveBeenCalled();
	});

	it("migrates only explicitly saved valid preferences, including scoped group seeds", () => {
		localStorage.setItem(key, "false");
		localStorage.setItem("quarterdeck.git-history-refs-panel-width", "NaN");
		localStorage.setItem("quarterdeck.detail-main-view", "files");
		localStorage.setItem("quarterdeck.file-browser-last-selected-path", "/private/draft");
		localStorage.setItem("auth-token", "private");
		localStorage.setItem("quarterdeck.project-groups-collapsed.org-1", '["ungrouped"]');
		expect(collectLegacyUiPreferences(localStorage)).toEqual({
			mode: "seed",
			values: { [key]: false },
			collapsedProjectGroups: { "org-1": ["ungrouped"] },
		});
	});

	it("preserves pending per-key choices across older snapshots and serializes patches", async () => {
		const store = new SharedUiPreferencesStore();
		let release: (value: RuntimeUiPreferences) => void = () => {};
		const firstWrite = new Promise<RuntimeUiPreferences>((resolve) => {
			release = resolve;
		});
		const patch = vi
			.fn()
			.mockImplementationOnce(() => firstWrite)
			.mockResolvedValueOnce({
				revision: 3,
				values: { [key]: true, "quarterdeck.onboarding.tips.dismissed": true },
				collapsedProjectGroups: {},
			});
		await store.initialize({ read: async () => empty, patch }, collectLegacyUiPreferences(null), vi.fn());
		store.write(key, "false");
		store.write(key, "true");
		await Promise.resolve();
		expect(patch).toHaveBeenCalledTimes(1);
		store.apply({
			revision: 2,
			values: { [key]: false, "quarterdeck.onboarding.tips.dismissed": true },
			collapsedProjectGroups: {},
		});
		expect(store.read(key)).toBe("true");
		release({ revision: 1, values: { [key]: false }, collapsedProjectGroups: {} });
		await store.flush();
		expect(patch).toHaveBeenCalledTimes(2);
		expect(store.read(key)).toBe("true");
		expect(store.read("quarterdeck.onboarding.tips.dismissed")).toBe("true");
		store.apply(empty);
		expect(store.read(key)).toBe("true");
	});

	it("defaults missing Git views to empty and initializes Git-only seeds from runtime authority", async () => {
		const store = new SharedUiPreferencesStore();
		expect(store.readGitView("task-a")).toEqual({});
		expect(store.readGitView("constructor")).toEqual({});
		const seed = { mode: "seed" as const, values: {}, gitViews: { "task-a": { activeTab: "compare" as const } } };
		const patch = vi.fn().mockResolvedValue({
			...empty,
			revision: 1,
			gitViews: { "task-a": { activeTab: "uncommitted", collapsedDirectories: ["src"] } },
		});
		await store.initialize({ read: async () => empty, patch }, seed, vi.fn());
		expect(patch).toHaveBeenCalledWith(seed);
		expect(store.readGitView("task-a")).toEqual({ activeTab: "uncommitted", collapsedDirectories: ["src"] });
		expect(store.readGitView("task-b")).toEqual({});
	});

	it("preserves pending Git view fields and independent scopes across snapshots and acknowledgments", async () => {
		const store = new SharedUiPreferencesStore();
		let releaseFirst: (value: RuntimeUiPreferences) => void = () => {};
		let releaseSecond: (value: RuntimeUiPreferences) => void = () => {};
		const firstWrite = new Promise<RuntimeUiPreferences>((resolve) => {
			releaseFirst = resolve;
		});
		const secondWrite = new Promise<RuntimeUiPreferences>((resolve) => {
			releaseSecond = resolve;
		});
		const patch = vi
			.fn()
			.mockImplementationOnce(() => firstWrite)
			.mockImplementationOnce(() => secondWrite)
			.mockResolvedValueOnce({
				...empty,
				revision: 4,
				gitViews: {
					"task-a": { activeTab: "compare", collapsedDirectories: ["src"] },
					"task-b": { activeTab: "compare", collapsedDirectories: ["docs"] },
				},
			})
			.mockResolvedValueOnce({
				...empty,
				revision: 5,
				gitViews: {
					"task-a": { activeTab: "uncommitted", collapsedDirectories: ["src"] },
					"task-b": { activeTab: "compare", collapsedDirectories: ["docs"] },
				},
			});
		await store.initialize({ read: async () => empty, patch }, collectLegacyUiPreferences(null), vi.fn());
		store.writeGitView("task-a", { activeTab: "compare" });
		store.writeGitView("task-a", { collapsedDirectories: ["src"] });
		store.writeGitView("task-b", { activeTab: "compare" });
		store.writeGitView("task-a", { activeTab: "uncommitted" });
		await Promise.resolve();
		expect(patch).toHaveBeenCalledTimes(1);
		store.apply({
			...empty,
			revision: 2,
			gitViews: {
				"task-a": { activeTab: "compare", collapsedDirectories: ["remote"] },
				"task-b": { collapsedDirectories: ["docs"] },
			},
		});
		expect(store.readGitView("task-a")).toEqual({ activeTab: "uncommitted", collapsedDirectories: ["src"] });
		expect(store.readGitView("task-b")).toEqual({ activeTab: "compare", collapsedDirectories: ["docs"] });
		releaseFirst({ ...empty, revision: 1, gitViews: { "task-a": { activeTab: "compare" } } });
		await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
		expect(store.readGitView("task-a")).toEqual({ activeTab: "uncommitted", collapsedDirectories: ["src"] });
		releaseSecond({
			...empty,
			revision: 3,
			gitViews: {
				"task-a": { activeTab: "compare", collapsedDirectories: ["src"] },
				"task-b": { collapsedDirectories: ["docs"] },
			},
		});
		await store.flush();
		expect(patch.mock.calls).toEqual([
			[{ mode: "patch", values: {}, gitViews: { "task-a": { activeTab: "compare" } } }],
			[{ mode: "patch", values: {}, gitViews: { "task-a": { collapsedDirectories: ["src"] } } }],
			[{ mode: "patch", values: {}, gitViews: { "task-b": { activeTab: "compare" } } }],
			[{ mode: "patch", values: {}, gitViews: { "task-a": { activeTab: "uncommitted" } } }],
		]);
		expect(store.readGitView("task-a")).toEqual({ activeTab: "uncommitted", collapsedDirectories: ["src"] });
		expect(store.readGitView("task-b")).toEqual({ activeTab: "compare", collapsedDirectories: ["docs"] });
	});

	it("validates Git view writes and rolls back failed pending fields without blocking later writes", async () => {
		const store = new SharedUiPreferencesStore();
		const onError = vi.fn();
		const patch = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({
				...empty,
				revision: 2,
				gitViews: { task: { activeTab: "compare", collapsedDirectories: [] } },
			});
		await store.initialize(
			{
				read: async () => ({
					...empty,
					revision: 1,
					gitViews: { task: { activeTab: "compare", collapsedDirectories: ["src"] } },
				}),
				patch,
			},
			collectLegacyUiPreferences(null),
			onError,
		);
		store.writeGitView("", { activeTab: "compare" });
		store.writeGitView("task", {});
		expect(onError).toHaveBeenCalledTimes(1);
		expect(patch).not.toHaveBeenCalled();
		store.writeGitView("task", { activeTab: "uncommitted" });
		expect(store.readGitView("task")).toEqual({ activeTab: "uncommitted", collapsedDirectories: ["src"] });
		await store.flush();
		expect(onError).toHaveBeenCalledTimes(2);
		expect(store.readGitView("task")).toEqual({ activeTab: "compare", collapsedDirectories: ["src"] });
		store.writeGitView("task", { collapsedDirectories: [] });
		await store.flush();
		expect(store.readGitView("task")).toEqual({ activeTab: "compare", collapsedDirectories: [] });
	});

	it("uses the seed response as authority and reports failed saves without poisoning later changes", async () => {
		localStorage.setItem(key, "false");
		const onError = vi.fn();
		const patch = vi
			.fn()
			.mockResolvedValueOnce({ ...empty, revision: 1, values: { [key]: true } })
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ ...empty, revision: 2, values: { [key]: null } });
		const store = new SharedUiPreferencesStore();
		await store.initialize({ read: async () => empty, patch }, collectLegacyUiPreferences(localStorage), onError);
		expect(store.read(key)).toBe("true");
		store.write(key, "false");
		await store.flush();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(store.read(key)).toBe("true");
		store.write(key, null);
		await store.flush();
		expect(store.read(key)).toBeNull();
	});
});
