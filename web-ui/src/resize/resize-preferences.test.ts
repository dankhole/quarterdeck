import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "./resize-preferences";

vi.mock("@/resize/resize-persistence", () => ({
	readPersistedResizeNumber: vi.fn(),
	writePersistedResizeNumber: vi.fn(),
}));

import { readPersistedResizeNumber, writePersistedResizeNumber } from "@/resize/resize-persistence";

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
