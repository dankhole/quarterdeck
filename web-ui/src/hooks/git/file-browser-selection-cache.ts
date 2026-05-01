import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

const lastSelectedPathByScope = new Map<string, string>();

(function hydrateLastSelectedFileBrowserPathCache(): void {
	const raw = readLocalStorageItem(LocalStorageKey.FileBrowserLastSelectedPath);
	if (!raw) return;
	try {
		const parsed: Record<string, string> = JSON.parse(raw);
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") {
				lastSelectedPathByScope.set(key, value);
			}
		}
	} catch {
		// Ignore corrupt data.
	}
})();

function persistLastSelectedFileBrowserPathCache(): void {
	writeLocalStorageItem(
		LocalStorageKey.FileBrowserLastSelectedPath,
		JSON.stringify(Object.fromEntries(lastSelectedPathByScope)),
	);
}

export function getLastSelectedFileBrowserPath(scopeKey: string): string | null {
	return lastSelectedPathByScope.get(scopeKey) ?? null;
}

export function setLastSelectedFileBrowserPath(scopeKey: string, path: string | null): void {
	if (path) {
		lastSelectedPathByScope.set(scopeKey, path);
	} else {
		lastSelectedPathByScope.delete(scopeKey);
	}
	persistLastSelectedFileBrowserPathCache();
}
