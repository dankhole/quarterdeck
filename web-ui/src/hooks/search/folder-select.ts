export interface FolderSelectFolderRow {
	kind: "folder";
	key: string;
	label: string;
	depth: number;
	expanded: boolean;
	count: number;
}

export interface FolderSelectItemRow<T> {
	kind: "item";
	key: string;
	item: T;
	label: string;
	depth: number;
}

export type FolderSelectRow<T> = FolderSelectFolderRow | FolderSelectItemRow<T>;

export interface FolderSelectOptions<T> {
	items: readonly T[];
	getKey: (item: T) => string;
	/** Full presentation path, including the final leaf. Omit to disable grouping. */
	getPath?: (item: T) => readonly string[];
	selectedKey?: string | null;
	isSearching: boolean;
}

export interface FolderSelectFolderNode<T> {
	kind: "folder";
	key: string;
	label: string;
	depth: number;
	count: number;
	children: FolderSelectNode<T>[];
}

export type FolderSelectNode<T> = FolderSelectFolderNode<T> | FolderSelectItemRow<T>;

export interface FolderSelectTree<T> {
	nodes: FolderSelectNode<T>[];
	selectedAncestors: ReadonlySet<string>;
}

/** JSON encodes segment boundaries and escaping; the tag separates folders from items. */
export function folderSelectFolderKey(path: readonly string[]): string {
	return JSON.stringify(["folder", ...path]);
}

function itemKey(key: string): string {
	return JSON.stringify(["item", key]);
}

/** Groups siblings by first occurrence without sorting or changing canonical item identity. */
export function buildFolderSelectTree<T>({
	items,
	getKey,
	getPath,
	selectedKey,
}: Omit<FolderSelectOptions<T>, "isSearching">): FolderSelectTree<T> {
	const nodes: FolderSelectNode<T>[] = [];
	const folders = new Map<string, FolderSelectFolderNode<T>>();
	const selectedAncestors = new Set<string>();

	for (const item of items) {
		const canonicalKey = getKey(item);
		const path = getPath?.(item) ?? [canonicalKey];
		let siblings = nodes;
		for (let depth = 0; depth < path.length - 1; depth++) {
			const key = folderSelectFolderKey(path.slice(0, depth + 1));
			let folder = folders.get(key);
			if (!folder) {
				folder = {
					kind: "folder",
					key,
					label: path[depth] ?? "",
					depth,
					count: 0,
					children: [],
				};
				folders.set(key, folder);
				siblings.push(folder);
			}
			folder.count++;
			if (canonicalKey === selectedKey) selectedAncestors.add(key);
			siblings = folder.children;
		}
		siblings.push({
			kind: "item",
			key: itemKey(canonicalKey),
			item,
			label: path.at(-1) ?? canonicalKey,
			depth: Math.max(0, path.length - 1),
		});
	}
	return { nodes, selectedAncestors };
}

/** Only visible rows are returned, so consumers cannot navigate collapsed descendants. */
export function flattenFolderSelectTree<T>(
	tree: FolderSelectTree<T>,
	expansion: ReadonlyMap<string, boolean> = new Map(),
): FolderSelectRow<T>[] {
	const rows: FolderSelectRow<T>[] = [];
	function visit(nodes: readonly FolderSelectNode<T>[]) {
		for (const node of nodes) {
			if (node.kind === "item") {
				rows.push(node);
			} else {
				const expanded = expansion.get(node.key) ?? tree.selectedAncestors.has(node.key);
				rows.push({
					kind: "folder",
					key: node.key,
					label: node.label,
					depth: node.depth,
					count: node.count,
					expanded,
				});
				if (expanded) visit(node.children);
			}
		}
	}
	visit(tree.nodes);
	return rows;
}

export function getFolderSelectRows<T>(
	options: FolderSelectOptions<T>,
	expansion?: ReadonlyMap<string, boolean>,
): FolderSelectRow<T>[] {
	if (!options.getPath || options.isSearching) {
		return options.items.map((item) => {
			const key = options.getKey(item);
			return { kind: "item", key: itemKey(key), item, label: key, depth: 0 };
		});
	}
	return flattenFolderSelectTree(buildFolderSelectTree(options), expansion);
}
