import type { DependencyList, Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import useReactUseDebounce from "react-use/lib/useDebounce.js";
import useReactUseEvent from "react-use/lib/useEvent.js";
import useReactUseInterval from "react-use/lib/useInterval.js";
import useReactUseMeasure from "react-use/lib/useMeasure.js";
import useReactUseTitle from "react-use/lib/useTitle.js";
import useReactUseUnmount from "react-use/lib/useUnmount.js";
import { readLocalStorageItem, subscribePreferenceStorage, writeLocalStorageItem } from "@/storage/local-storage-store";
import { isSharedUiPreferenceKey, sharedUiPreferences } from "@/storage/shared-ui-preferences";

type DomEventOptions = boolean | AddEventListenerOptions;
type StateSetter<T> = Dispatch<SetStateAction<T>>;

function getWindowTarget(): Window | null {
	if (typeof window === "undefined") {
		return null;
	}
	return window;
}

function getDocumentTarget(): Document | null {
	if (typeof document === "undefined") {
		return null;
	}
	return document;
}

export function useWindowEvent<K extends keyof WindowEventMap>(
	name: K,
	handler: ((event: WindowEventMap[K]) => void) | null,
	options?: DomEventOptions,
): void {
	useReactUseEvent(name, handler as ((event?: Event) => void) | null, getWindowTarget(), options);
}

export function useDocumentEvent<K extends keyof DocumentEventMap>(
	name: K,
	handler: ((event: DocumentEventMap[K]) => void) | null,
	options?: DomEventOptions,
): void {
	useReactUseEvent(name, handler as ((event?: Event) => void) | null, getDocumentTarget(), options);
}

export function useInterval(callback: () => void, delayMs: number | null): void {
	useReactUseInterval(callback, delayMs);
}

export function useDebouncedEffect(effect: () => void, delayMs: number, deps: DependencyList): void {
	useReactUseDebounce(effect, delayMs, deps);
}

function resolveNextValue<T>(nextValue: SetStateAction<T>, currentValue: T): T {
	if (typeof nextValue === "function") {
		return (nextValue as (previousValue: T) => T)(currentValue);
	}
	return nextValue;
}

export function useBooleanLocalStorageValue(key: string, initialValue: boolean): [boolean, StateSetter<boolean>] {
	const raw = useSyncExternalStore(subscribePreferenceStorage, () => readLocalStorageItem(key));
	const [fallbackValue, setFallbackValue] = useState(initialValue);
	const storedValue =
		raw === null
			? sharedUiPreferences.active && isSharedUiPreferenceKey(key)
				? initialValue
				: fallbackValue
			: raw === "true";
	const setStoredValue = useCallback(
		(value: boolean) => {
			setFallbackValue(value);
			writeLocalStorageItem(key, String(value));
		},
		[key],
	);
	const value = storedValue ?? initialValue;
	// Resolve functional updates against the current choice, including unavailable storage.
	const valueRef = useRef(value);
	valueRef.current = value;
	const setValue: StateSetter<boolean> = useCallback(
		(nextValue) => {
			const resolved = resolveNextValue(nextValue, valueRef.current);
			setStoredValue(resolved);
		},
		[setStoredValue],
	);
	return [value, setValue];
}

export function useRawLocalStorageValue<T extends string>(
	key: string,
	initialValue: T,
	normalize: (value: string) => T | null,
): [T, StateSetter<T>] {
	const raw = useSyncExternalStore(subscribePreferenceStorage, () => readLocalStorageItem(key));
	const [fallbackValue, setFallbackValue] = useState(initialValue);
	const storedValue =
		raw ?? (sharedUiPreferences.active && isSharedUiPreferenceKey(key) ? initialValue : fallbackValue);
	const setStoredValue = useCallback(
		(value: T) => {
			setFallbackValue(value);
			writeLocalStorageItem(key, value);
		},
		[key],
	);
	const value = storedValue ? (normalize(storedValue) ?? initialValue) : initialValue;
	// Resolve functional updates against the current choice.
	const valueRef = useRef(value);
	valueRef.current = value;
	const setValue: StateSetter<T> = useCallback(
		(nextValue) => {
			const resolved = resolveNextValue(nextValue, valueRef.current);
			setStoredValue(resolved);
		},
		[setStoredValue],
	);
	return [value, setValue];
}

export function useDocumentTitle(title: string): void {
	useReactUseTitle(title);
}

export function useMeasure<T extends Element = Element>() {
	return useReactUseMeasure<T>();
}

export function useUnmount(fn: () => void): void {
	useReactUseUnmount(fn);
}

export interface LoadingGuard {
	isLoading: boolean;
	run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
	reset: () => void;
}

export function useLoadingGuard(): LoadingGuard {
	const [isLoading, setIsLoading] = useState(false);
	const loadingRef = useRef(false);
	const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
		if (loadingRef.current) return undefined;
		loadingRef.current = true;
		setIsLoading(true);
		try {
			return await fn();
		} finally {
			loadingRef.current = false;
			setIsLoading(false);
		}
	}, []);
	const reset = useCallback(() => {
		loadingRef.current = false;
		setIsLoading(false);
	}, []);
	return useMemo(() => ({ isLoading, run, reset }), [isLoading, run, reset]);
}
