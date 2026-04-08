import { afterEach, describe, expect, it } from "vitest";

import { loadActiveTab } from "@/resize/use-card-detail-layout";
import { LocalStorageKey } from "@/storage/local-storage-store";

describe("loadActiveTab", () => {
	afterEach(() => {
		window.localStorage.clear();
	});

	it('returns "home" when "quarterdeck" is stored (migration)', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "quarterdeck");
		expect(loadActiveTab()).toBe("home");
	});

	it('returns "home" when "home" is stored', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "home");
		expect(loadActiveTab()).toBe("home");
	});

	it('returns "changes" when "changes" is stored', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "changes");
		expect(loadActiveTab()).toBe("changes");
	});

	it('returns "files" when "files" is stored', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "files");
		expect(loadActiveTab()).toBe("files");
	});

	it("returns null when empty string is stored (panel collapsed)", () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "");
		expect(loadActiveTab()).toBeNull();
	});

	it('returns "home" when no value is stored (default for new installs)', () => {
		// No localStorage item set
		expect(loadActiveTab()).toBe("home");
	});

	it('returns "home" when an invalid value is stored', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "bogus");
		expect(loadActiveTab()).toBe("home");
	});
});
