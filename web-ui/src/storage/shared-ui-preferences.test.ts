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
