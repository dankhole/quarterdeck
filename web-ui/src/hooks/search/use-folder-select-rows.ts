import { useCallback, useMemo, useState } from "react";
import {
	buildFolderSelectTree,
	type FolderSelectOptions,
	type FolderSelectRow,
	flattenFolderSelectTree,
	getFolderSelectRows,
} from "@/hooks/search/folder-select";

export type UseFolderSelectRowsOptions<T> = FolderSelectOptions<T>;

export interface UseFolderSelectRowsResult<T> {
	rows: FolderSelectRow<T>[];
	toggleFolder: (folderKey: string) => void;
	resetFolders: () => void;
}

interface FolderExpansionState {
	selectedKey: string | null | undefined;
	overrides: ReadonlyMap<string, boolean>;
}

/** Keep item arrays and pure key/path callbacks stable to reuse presentation rows across parent renders. */
export function useFolderSelectRows<T>(options: UseFolderSelectRowsOptions<T>): UseFolderSelectRowsResult<T> {
	const [state, setState] = useState<FolderExpansionState>(() => ({
		selectedKey: options.selectedKey,
		overrides: new Map(),
	}));
	// A new selection starts from its own ancestors, without waiting for an effect.
	// Item/filter changes deliberately do not reset the user's expansion choices.
	let currentState = state;
	if (state.selectedKey !== options.selectedKey) {
		currentState = { selectedKey: options.selectedKey, overrides: new Map() };
		setState(currentState);
	}
	const { items, getKey, getPath, selectedKey, isSearching } = options;
	const tree = useMemo(
		() => (getPath && !isSearching ? buildFolderSelectTree({ items, getKey, getPath, selectedKey }) : null),
		[items, getKey, getPath, selectedKey, isSearching],
	);
	const expansion = tree ? currentState.overrides : undefined;
	const rows = useMemo(
		() =>
			tree ? flattenFolderSelectTree(tree, expansion) : getFolderSelectRows({ items, getKey, isSearching: true }),
		[tree, expansion, items, getKey],
	);

	const toggleFolder = useCallback(
		(folderKey: string) => {
			const row = rows.find((candidate) => candidate.kind === "folder" && candidate.key === folderKey);
			if (row?.kind !== "folder") return;
			setState((current) => {
				const overrides = new Map(current.overrides);
				overrides.set(folderKey, !(overrides.get(folderKey) ?? row.expanded));
				return { ...current, overrides };
			});
		},
		[rows],
	);

	// Stable identity lets picker close effects depend on this callback safely.
	const resetFolders = useCallback(() => {
		setState((current) => (current.overrides.size === 0 ? current : { ...current, overrides: new Map() }));
	}, []);

	return { rows, toggleFolder, resetFolders };
}
