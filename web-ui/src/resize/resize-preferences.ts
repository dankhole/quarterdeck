import { readPersistedResizeNumber, writePersistedResizeNumber } from "@/resize/resize-persistence";
import type { LocalStorageKey } from "@/storage/local-storage-store";

export interface ResizeNumberPreference {
	defaultValue: number | (() => number);
	key: LocalStorageKey;
	normalize?: (value: number) => number;
}

export function getResizePreferenceDefaultValue(preference: ResizeNumberPreference): number {
	return typeof preference.defaultValue === "function" ? preference.defaultValue() : preference.defaultValue;
}

export function loadResizePreference(preference: ResizeNumberPreference): number {
	return readPersistedResizeNumber({
		key: preference.key,
		fallback: getResizePreferenceDefaultValue(preference),
		normalize: preference.normalize,
	});
}

export function persistResizePreference(preference: ResizeNumberPreference, value: number): number {
	return writePersistedResizeNumber({
		key: preference.key,
		value,
		normalize: preference.normalize,
	});
}
