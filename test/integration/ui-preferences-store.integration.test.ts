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
