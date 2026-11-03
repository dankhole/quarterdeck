import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UiPreferencesStore } from "../../src/config/ui-preferences-store.js";
import { runtimeUiPreferencesPatchSchema } from "../../src/core/api/ui-preferences.js";
import { createTempDir } from "../utilities/temp-dir.js";

describe("shared UI preference persistence", () => {
	it("can read a near-limit accepted file after saving it", async () => {
		const temp = createTempDir();
		try {
			const path = join(temp.path, "ui-preferences.json");
			const store = new UiPreferencesStore(path);
			const ids = Array.from(
				{ length: 1_000 },
				(_, index) => `group-${String(index).padStart(4, "0")}-${"a".repeat(48)}`,
			);
			const saved = await store.patch({ mode: "patch", values: {}, collapsedProjectGroups: { "org-1": ids } });
			expect(Buffer.byteLength(await readFile(path, "utf8"))).toBeLessThanOrEqual(64 * 1_024);
			expect(await new UiPreferencesStore(path).read()).toEqual(saved);
		} finally {
			await temp.cleanupAsync();
		}
	});

	it("merges two concurrent clients and preserves seed precedence and reset tombstones after restart", async () => {
		const temp = createTempDir();
		try {
			const path = join(temp.path, "ui-preferences.json");
			const browser = new UiPreferencesStore(path);
			const desktop = new UiPreferencesStore(path);
			expect(await browser.read()).toEqual({ revision: 0, values: {}, collapsedProjectGroups: {} });
			await Promise.all([
				browser.patch({ mode: "patch", values: { "quarterdeck.file-browser-word-wrap": false } }),
				desktop.patch({ mode: "patch", values: { "quarterdeck.git-history-refs-panel-width": 320 } }),
			]);
			await desktop.patch({
				mode: "seed",
				values: {
					"quarterdeck.file-browser-word-wrap": true,
					"quarterdeck.onboarding.tips.dismissed": true,
				},
			});
			await browser.patch({ mode: "patch", values: { "quarterdeck.git-history-refs-panel-width": null } });
			const restarted = new UiPreferencesStore(path);
			const saved = await restarted.patch({
				mode: "seed",
				values: { "quarterdeck.git-history-refs-panel-width": 500 },
			});
			expect(saved).toEqual({
				revision: 4,
				values: {
					"quarterdeck.file-browser-word-wrap": false,
					"quarterdeck.git-history-refs-panel-width": null,
					"quarterdeck.onboarding.tips.dismissed": true,
				},
				collapsedProjectGroups: {},
			});
		} finally {
			await temp.cleanupAsync();
		}
	});

	it("merges Git view fields and scopes across concurrent clients and a fresh disk store", async () => {
		const temp = createTempDir();
		try {
			const path = join(temp.path, "ui-preferences.json");
			const legacy = {
				revision: 7,
				values: { "quarterdeck.file-browser-word-wrap": false },
				collapsedProjectGroups: { "org-1": ["group-a"] },
			};
			await writeFile(path, JSON.stringify(legacy));
			const browser = new UiPreferencesStore(path);
			const desktop = new UiPreferencesStore(path);
			expect(await browser.read()).toEqual(legacy);
			await Promise.all([
				browser.patch({ mode: "patch", values: {}, gitViews: { "project/task-a": { activeTab: "compare" } } }),
				desktop.patch({
					mode: "patch",
					values: {},
					gitViews: { "project/task-a": { collapsedDirectories: ["src", "docs/guides"] } },
				}),
				desktop.patch({ mode: "patch", values: {}, gitViews: { "project/task-b": { activeTab: "uncommitted" } } }),
			]);
			const saved = await new UiPreferencesStore(path).read();
			expect(saved).toEqual({
				...legacy,
				revision: 10,
				gitViews: {
					"project/task-a": { activeTab: "compare", collapsedDirectories: ["src", "docs/guides"] },
					"project/task-b": { activeTab: "uncommitted" },
				},
			});
			await browser.patch({
				mode: "seed",
				values: {},
				gitViews: {
					"project/task-a": { activeTab: "uncommitted", collapsedDirectories: [] },
					"project/task-b": { activeTab: "compare", collapsedDirectories: ["test"] },
				},
			});
			expect((await desktop.read()).gitViews).toEqual({
				...saved.gitViews,
				"project/task-b": { activeTab: "uncommitted", collapsedDirectories: ["test"] },
			});
			await desktop.patch({
				mode: "patch",
				values: {},
				gitViews: { "project/task-a": { activeTab: "uncommitted", collapsedDirectories: [] } },
			});
			const beforeSeed = await browser.read();
			expect(
				await browser.patch({
					mode: "seed",
					values: {},
					gitViews: { "project/task-a": { activeTab: "compare", collapsedDirectories: ["src"] } },
				}),
			).toEqual(beforeSeed);
			expect((await new UiPreferencesStore(path).read()).gitViews?.["project/task-a"]).toEqual({
				activeTab: "uncommitted",
				collapsedDirectories: [],
			});
		} finally {
			await temp.cleanupAsync();
		}
	});

	it("bounds Git view scopes, paths, counts, and total encoded preference bytes", async () => {
		const invalidViews = [
			{ "": {} },
			{ ["s".repeat(1_025)]: {} },
			{ scope: { activeTab: "history" } },
			{ scope: { collapsedDirectories: [""] } },
			{ scope: { collapsedDirectories: ["p".repeat(4_097)] } },
			{ scope: { collapsedDirectories: Array.from({ length: 513 }, () => "src") } },
			Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`scope-${index}`, {}])),
			{ scope: { collapsedDirectories: Array.from({ length: 20 }, () => "é".repeat(2_000)) } },
		];
		for (const gitViews of invalidViews) {
			expect(runtimeUiPreferencesPatchSchema.safeParse({ mode: "patch", values: {}, gitViews }).success).toBe(false);
		}
		const temp = createTempDir();
		try {
			const path = join(temp.path, "ui-preferences.json");
			const store = new UiPreferencesStore(path);
			const collapsedDirectories = Array.from({ length: 24 }, (_, index) => `${index}/${"p".repeat(2_000)}`);
			const saved = await store.patch({ mode: "patch", values: {}, gitViews: { first: { collapsedDirectories } } });
			await expect(
				store.patch({ mode: "patch", values: {}, gitViews: { second: { collapsedDirectories } } }),
			).rejects.toThrow("storage limit");
			expect(await new UiPreferencesStore(path).read()).toEqual(saved);
		} finally {
			await temp.cleanupAsync();
		}
	});

	it("keeps independent organization seeds and rejects arbitrary storage and malformed disk data", async () => {
		const temp = createTempDir();
		try {
			const path = join(temp.path, "ui-preferences.json");
			const store = new UiPreferencesStore(path);
			await store.patch({ mode: "patch", values: {}, collapsedProjectGroups: { "org-1": ["ungrouped"] } });
			await store.patch({ mode: "seed", values: {}, collapsedProjectGroups: { "org-1": [], "org-2": ["group-a"] } });
			expect((await store.read()).collapsedProjectGroups).toEqual({ "org-1": ["ungrouped"], "org-2": ["group-a"] });
			expect(
				runtimeUiPreferencesPatchSchema.safeParse({ mode: "patch", values: { "auth-token": "secret" } }).success,
			).toBe(false);
			expect(
				runtimeUiPreferencesPatchSchema.safeParse({
					mode: "patch",
					values: { "quarterdeck.file-browser-word-wrap": "false" },
				}).success,
			).toBe(false);
			await writeFile(path, "invalid JSON");
			await expect(store.read()).rejects.toThrow();
			await expect(
				store.patch({ mode: "patch", values: { "quarterdeck.file-browser-word-wrap": true } }),
			).rejects.toThrow();
			expect(await readFile(path, "utf8")).toBe("invalid JSON");
		} finally {
			await temp.cleanupAsync();
		}
	});
});
