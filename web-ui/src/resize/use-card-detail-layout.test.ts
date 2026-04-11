import { afterEach, describe, expect, it } from "vitest";

import { loadLastSidebarTab, loadMainView, loadSidebar } from "@/resize/use-card-detail-layout";
import { LocalStorageKey } from "@/storage/local-storage-store";

afterEach(() => {
	window.localStorage.clear();
});

describe("loadMainView", () => {
	it('returns stored value when new key exists ("home")', () => {
		window.localStorage.setItem(LocalStorageKey.DetailMainView, "home");
		expect(loadMainView()).toBe("home");
	});

	it('returns stored value when new key exists ("terminal")', () => {
		window.localStorage.setItem(LocalStorageKey.DetailMainView, "terminal");
		expect(loadMainView()).toBe("terminal");
	});

	it('returns stored value when new key exists ("files")', () => {
		window.localStorage.setItem(LocalStorageKey.DetailMainView, "files");
		expect(loadMainView()).toBe("files");
	});

	it('migrates legacy "task_column" to "terminal"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "task_column");
		expect(loadMainView()).toBe("terminal");
	});

	it('returns stored value when new key exists ("git")', () => {
		window.localStorage.setItem(LocalStorageKey.DetailMainView, "git");
		expect(loadMainView()).toBe("git");
	});

	it('migrates stored "changes" to "git"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailMainView, "changes");
		expect(loadMainView()).toBe("git");
	});

	it('migrates legacy "changes" to "terminal"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "changes");
		expect(loadMainView()).toBe("terminal");
	});

	it('migrates legacy "files" to "files"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "files");
		expect(loadMainView()).toBe("files");
	});

	it('migrates legacy "home" to "home"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "home");
		expect(loadMainView()).toBe("home");
	});

	it('migrates legacy "projects" to "home"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "projects");
		expect(loadMainView()).toBe("home");
	});

	it('migrates legacy "" (collapsed) to "home"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "");
		expect(loadMainView()).toBe("home");
	});

	it('returns "home" when no value is stored (new install)', () => {
		expect(loadMainView()).toBe("home");
	});

	it("prefers new key over legacy key", () => {
		window.localStorage.setItem(LocalStorageKey.DetailMainView, "files");
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "home");
		expect(loadMainView()).toBe("files");
	});
});

describe("loadSidebar", () => {
	it('returns stored value when new key exists ("projects")', () => {
		window.localStorage.setItem(LocalStorageKey.DetailSidebar, "projects");
		expect(loadSidebar()).toBe("projects");
	});

	it('returns stored value when new key exists ("task_column")', () => {
		window.localStorage.setItem(LocalStorageKey.DetailSidebar, "task_column");
		expect(loadSidebar()).toBe("task_column");
	});

	it("returns null when new key is empty (collapsed)", () => {
		window.localStorage.setItem(LocalStorageKey.DetailSidebar, "");
		expect(loadSidebar()).toBeNull();
	});

	it('migrates legacy "task_column" to "task_column"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "task_column");
		expect(loadSidebar()).toBe("task_column");
	});

	it('migrates legacy "changes" to "task_column"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "changes");
		expect(loadSidebar()).toBe("task_column");
	});

	it("migrates legacy collapsed to null", () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "");
		expect(loadSidebar()).toBeNull();
	});

	it('migrates legacy "home" to "projects"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "home");
		expect(loadSidebar()).toBe("projects");
	});

	it('migrates legacy "files" to "projects"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "files");
		expect(loadSidebar()).toBe("projects");
	});

	it('returns "projects" when no value is stored (new install)', () => {
		expect(loadSidebar()).toBe("projects");
	});

	it("prefers new key over legacy key", () => {
		window.localStorage.setItem(LocalStorageKey.DetailSidebar, "task_column");
		window.localStorage.setItem(LocalStorageKey.DetailActivePanel, "home");
		expect(loadSidebar()).toBe("task_column");
	});

	it('migrates stored "changes" to "task_column"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailSidebar, "changes");
		expect(loadSidebar()).toBe("task_column");
	});
});

describe("loadLastSidebarTab", () => {
	it('returns stored value when new key exists ("task_column")', () => {
		window.localStorage.setItem(LocalStorageKey.DetailLastSidebarTab, "task_column");
		expect(loadLastSidebarTab()).toBe("task_column");
	});

	it('migrates stored "changes" to "task_column"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailLastSidebarTab, "changes");
		expect(loadLastSidebarTab()).toBe("task_column");
	});

	it('migrates legacy "changes" from old key to "task_column"', () => {
		window.localStorage.setItem(LocalStorageKey.DetailLastTaskTab, "changes");
		expect(loadLastSidebarTab()).toBe("task_column");
	});

	it('returns "task_column" when no value stored (default)', () => {
		expect(loadLastSidebarTab()).toBe("task_column");
	});

	it("prefers new key over legacy key", () => {
		window.localStorage.setItem(LocalStorageKey.DetailLastSidebarTab, "task_column");
		window.localStorage.setItem(LocalStorageKey.DetailLastTaskTab, "projects");
		expect(loadLastSidebarTab()).toBe("task_column");
	});
});
