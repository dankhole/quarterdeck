import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	getResizePreferenceDefaultValue,
	loadBooleanResizePreference,
	loadResizePreference,
	persistBooleanResizePreference,
	persistResizePreference,
	type ResizeBooleanPreference,
	type ResizeNumberPreference,
} from "./resize-preferences";

vi.mock("@/resize/resize-persistence", () => ({
	readPersistedResizeNumber: vi.fn(),
	writePersistedResizeNumber: vi.fn(),
}));

vi.mock("@/storage/local-storage-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/storage/local-storage-store")>();
	return {
		...actual,
		readLocalStorageItem: vi.fn(),
		writeLocalStorageItem: vi.fn(),
	};
});

import { readPersistedResizeNumber, writePersistedResizeNumber } from "@/resize/resize-persistence";
import { readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

describe("getResizePreferenceDefaultValue", () => {
	it("returns static number default", () => {
		const pref: ResizeNumberPreference = {
			defaultValue: 42,
			key: LocalStorageKey.BottomTerminalPaneHeight,
		};
		expect(getResizePreferenceDefaultValue(pref)).toBe(42);
	});

	it("calls function default and returns result", () => {
		const pref: ResizeNumberPreference = {
			defaultValue: () => 99,
			key: LocalStorageKey.BottomTerminalPaneHeight,
		};
		expect(getResizePreferenceDefaultValue(pref)).toBe(99);
	});
});

describe("loadResizePreference", () => {
	beforeEach(() => {
		vi.mocked(readPersistedResizeNumber).mockReset();
	});

	it("delegates to readPersistedResizeNumber with correct args", () => {
		const normalize = (v: number) => Math.round(v);
		const pref: ResizeNumberPreference = {
			defaultValue: 50,
			key: LocalStorageKey.DetailSidePanelRatio,
			normalize,
		};
		vi.mocked(readPersistedResizeNumber).mockReturnValue(60);

		const result = loadResizePreference(pref);

		expect(readPersistedResizeNumber).toHaveBeenCalledWith({
			key: LocalStorageKey.DetailSidePanelRatio,
			fallback: 50,
			normalize,
		});
		expect(result).toBe(60);
	});

	it("resolves function default before passing as fallback", () => {
		const pref: ResizeNumberPreference = {
			defaultValue: () => 75,
			key: LocalStorageKey.BottomTerminalPaneHeight,
		};
		vi.mocked(readPersistedResizeNumber).mockReturnValue(75);

		loadResizePreference(pref);

		expect(vi.mocked(readPersistedResizeNumber).mock.calls[0]?.[0]).toMatchObject({
			fallback: 75,
		});
	});
});

describe("persistResizePreference", () => {
	beforeEach(() => {
		vi.mocked(writePersistedResizeNumber).mockReset();
	});

	it("delegates to writePersistedResizeNumber and returns result", () => {
		const pref: ResizeNumberPreference = {
			defaultValue: 50,
			key: LocalStorageKey.DetailSidePanelRatio,
		};
		vi.mocked(writePersistedResizeNumber).mockReturnValue(55);

		const result = persistResizePreference(pref, 55);

		expect(writePersistedResizeNumber).toHaveBeenCalledWith({
			key: LocalStorageKey.DetailSidePanelRatio,
			value: 55,
			normalize: undefined,
		});
		expect(result).toBe(55);
	});
});

describe("loadBooleanResizePreference", () => {
	beforeEach(() => {
		vi.mocked(readLocalStorageItem).mockReset();
	});

	const pref: ResizeBooleanPreference = {
		defaultValue: false,
		key: LocalStorageKey.SidebarPinned,
	};

	it("returns default when storage is null", () => {
		vi.mocked(readLocalStorageItem).mockReturnValue(null);
		expect(loadBooleanResizePreference(pref)).toBe(false);
	});

	it("returns true when stored value is 'true'", () => {
		vi.mocked(readLocalStorageItem).mockReturnValue("true");
		expect(loadBooleanResizePreference(pref)).toBe(true);
	});

	it("returns false when stored value is 'false'", () => {
		vi.mocked(readLocalStorageItem).mockReturnValue("false");
		expect(loadBooleanResizePreference(pref)).toBe(false);
	});

	it("returns false for non-'true' stored values", () => {
		vi.mocked(readLocalStorageItem).mockReturnValue("yes");
		expect(loadBooleanResizePreference(pref)).toBe(false);
	});

	it("respects default=true when storage is null", () => {
		vi.mocked(readLocalStorageItem).mockReturnValue(null);
		expect(loadBooleanResizePreference({ ...pref, defaultValue: true })).toBe(true);
	});
});

describe("persistBooleanResizePreference", () => {
	beforeEach(() => {
		vi.mocked(writeLocalStorageItem).mockReset();
	});

	const pref: ResizeBooleanPreference = {
		defaultValue: false,
		key: LocalStorageKey.SidebarPinned,
	};

	it("writes 'true' to storage and returns true", () => {
		const result = persistBooleanResizePreference(pref, true);
		expect(writeLocalStorageItem).toHaveBeenCalledWith(LocalStorageKey.SidebarPinned, "true");
		expect(result).toBe(true);
	});

	it("writes 'false' to storage and returns false", () => {
		const result = persistBooleanResizePreference(pref, false);
		expect(writeLocalStorageItem).toHaveBeenCalledWith(LocalStorageKey.SidebarPinned, "false");
		expect(result).toBe(false);
	});
});
