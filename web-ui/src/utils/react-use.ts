import type { DependencyList, Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
	useDebounce as useReactUseDebounce,
	useEvent as useReactUseEvent,
	useInterval as useReactUseInterval,
	useLocalStorage as useReactUseLocalStorage,
	useMeasure as useReactUseMeasure,
	useTitle as useReactUseTitle,
	useUnmount as useReactUseUnmount,
} from "react-use";

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
	const [storedValue, setStoredValue] = useReactUseLocalStorage<boolean>(key, initialValue, {
		raw: false,
		serializer: (value) => String(value),
		deserializer: (value) => value === "true",
	});
	const value = storedValue ?? initialValue;
	// react-use's useLocalStorage setter has a stale closure bug: its functional updater
	// form always receives the initial state because `state` isn't in useCallback's deps.
	// Work around by tracking the current value in a ref and resolving updates ourselves.
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
	const [storedValue, setStoredValue] = useReactUseLocalStorage<string>(key, initialValue, {
		raw: true,
	});
	const value = storedValue ? (normalize(storedValue) ?? initialValue) : initialValue;
	// Same stale closure workaround as useBooleanLocalStorageValue above.
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
