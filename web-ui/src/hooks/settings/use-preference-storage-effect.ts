import { useEffect, useRef } from "react";
import { readLocalStorageItem, subscribePreferenceStorage } from "@/storage/local-storage-store";

/** Update mounted preference owners without changing transient navigation/drafts. */
export function usePreferenceStorageEffect(key: string, onChange: () => void): void {
	const callback = useRef(onChange);
	callback.current = onChange;
	useEffect(() => {
		let previous = readLocalStorageItem(key);
		return subscribePreferenceStorage(() => {
			const next = readLocalStorageItem(key);
			if (next === previous) return;
			previous = next;
			callback.current();
		});
	}, [key]);
}
