import type { RuntimeWorkdirFileChange } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

// --- Types ---

export type GitViewTab = "uncommitted" | "last_turn" | "compare";

// --- Tab persistence ---

export function loadGitViewTab(): GitViewTab {
	const stored = readLocalStorageItem(LocalStorageKey.GitViewActiveTab);
	if (stored === "uncommitted" || stored === "last_turn" || stored === "compare") return stored;
	return "uncommitted";
}

export function persistGitViewTab(tab: GitViewTab): void {
	writeLocalStorageItem(LocalStorageKey.GitViewActiveTab, tab);
}

// --- Last-selected-path persistence ---

const lastSelectedPathByScope = new Map<string, string>();

(function hydrateLastSelectedPathCache(): void {
	const raw = readLocalStorageItem(LocalStorageKey.GitViewLastSelectedPath);
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

function persistLastSelectedPathToStorage(): void {
	writeLocalStorageItem(
		LocalStorageKey.GitViewLastSelectedPath,
		JSON.stringify(Object.fromEntries(lastSelectedPathByScope)),
	);
}

export function lastSelectedPathScopeKey(taskId: string | null, tab: GitViewTab): string {
	return `${taskId ?? "__home__"}::${tab}`;
}

export function getLastSelectedPath(taskId: string | null, tab: GitViewTab): string | undefined {
	return lastSelectedPathByScope.get(lastSelectedPathScopeKey(taskId, tab));
}

export function setLastSelectedPath(taskId: string | null, tab: GitViewTab, path: string): void {
	lastSelectedPathByScope.set(lastSelectedPathScopeKey(taskId, tab), path);
	persistLastSelectedPathToStorage();
}

// --- Derived state helpers ---

export function deriveActiveFiles(
	activeTab: GitViewTab,
	uncommittedFiles: RuntimeWorkdirFileChange[] | null | undefined,
	lastTurnFiles: RuntimeWorkdirFileChange[] | null | undefined,
	compareFiles: RuntimeWorkdirFileChange[] | null | undefined,
): RuntimeWorkdirFileChange[] | null {
	if (activeTab === "uncommitted") return uncommittedFiles ?? null;
	if (activeTab === "last_turn") return lastTurnFiles ?? null;
	if (activeTab === "compare") return compareFiles ?? null;
	return null;
}

export function deriveEmptyTitle(
	activeTab: GitViewTab,
	hasCompareRefs: boolean,
	includeUncommitted: boolean,
	sourceRef: string | null,
	targetRef: string | null,
): string {
	if (activeTab === "last_turn") return "No changes since last turn";
	if (activeTab === "uncommitted") return "No uncommitted changes";
	if (activeTab === "compare" && hasCompareRefs) {
		return includeUncommitted
			? `No differences between working tree and ${targetRef}.`
			: `No differences between ${sourceRef} and ${targetRef}.`;
	}
	return "No changes";
}
