import type { RuntimeListFilesResponse, RuntimeWorkdirEntryKind } from "@/runtime/types";

export interface FileTreeDirectoryPage {
	readonly data: RuntimeListFilesResponse | null;
	readonly loading: boolean;
	readonly loadingVisible?: boolean;
	readonly error: Error | null;
}

export type FileTreeDirectoryPages = Readonly<Record<string, FileTreeDirectoryPage>>;

export function mergeDirectoryPage(
	previous: RuntimeListFilesResponse | null,
	page: RuntimeListFilesResponse,
	append: boolean,
): RuntimeListFilesResponse {
	if (!previous || previous.snapshotId !== page.snapshotId) return page;
	// A first-page poll of the same snapshot must not discard appended pages.
	if (!append) return { ...previous, mutable: page.mutable, mutationBlockedReason: page.mutationBlockedReason };
	return {
		...page,
		files: [...new Set([...previous.files, ...page.files])],
		directories: [...new Set([...(previous.directories ?? []), ...(page.directories ?? [])])],
		hiddenCount: previous.hiddenCount + page.hiddenCount,
	};
}

export function projectLoadedTree(pages: FileTreeDirectoryPages): { files: string[]; directories: string[] } {
	const files = new Set<string>();
	const directories = new Set<string>();
	const visit = (directory: string) => {
		const page = pages[directory]?.data;
		if (!page) return;
		for (const file of page.files) files.add(file);
		for (const child of page.directories ?? []) {
			if (directories.has(child)) continue;
			directories.add(child);
			visit(child);
		}
	};
	visit("");
	return { files: [...files], directories: [...directories] };
}

export function visibleExpandedDirectories(expanded: ReadonlySet<string>): string[] {
	return [...expanded].filter((directory) => {
		let index = directory.indexOf("/");
		while (index >= 0) {
			if (!expanded.has(directory.slice(0, index))) return false;
			index = directory.indexOf("/", index + 1);
		}
		return true;
	});
}

export function parentDirectories(path: string): string[] {
	const parents = [""];
	for (let index = path.indexOf("/"); index >= 0; index = path.indexOf("/", index + 1)) {
		parents.push(path.slice(0, index));
	}
	return parents;
}

export interface FileTreeMutationProjection {
	readonly scopeKey: string;
	readonly entries: ReadonlyMap<
		string,
		{ readonly kind: RuntimeWorkdirEntryKind; readonly snapshotId: string | null }
	>;
	readonly removed: ReadonlyMap<string, string | null>;
}

/** Mutation receipts can reveal paths outside loaded pages, but listing absence cannot delete them. */
export function projectFileTree(
	pages: FileTreeDirectoryPages,
	receipts: FileTreeMutationProjection,
	scopeKey: string,
	showExcluded: boolean,
): { files: string[]; directories: string[] } {
	const projected = projectLoadedTree(pages);
	if (receipts.scopeKey !== scopeKey) return projected;
	const retained = (path: string) =>
		![...receipts.removed].some(([removed, snapshotId]) => {
			const parent = parentDirectories(removed).at(-1) ?? "";
			return pages[parent]?.data?.snapshotId === snapshotId && (path === removed || path.startsWith(`${removed}/`));
		});
	projected.files = projected.files.filter(retained);
	projected.directories = projected.directories.filter(retained);
	for (const [path, { kind }] of reconcileFileTreeMutationReceipts(receipts, pages).entries) {
		if (!showExcluded && /(?:^|\/)\.claude\/worktrees(?:\/|$)/.test(path)) continue;
		for (const parent of parentDirectories(path)) if (parent) projected.directories.push(parent);
		(kind === "directory" ? projected.directories : projected.files).push(path);
	}
	return { files: [...new Set(projected.files)], directories: [...new Set(projected.directories)] };
}

export function applyFileTreeMutationReceipt(
	current: FileTreeMutationProjection,
	pages: FileTreeDirectoryPages,
	scopeKey: string,
	path: string,
	kind: RuntimeWorkdirEntryKind,
	removedPath?: string,
): FileTreeMutationProjection {
	const entries = new Map(current.scopeKey === scopeKey ? current.entries : []);
	if (removedPath)
		for (const entry of entries.keys()) {
			if (entry === removedPath || entry.startsWith(`${removedPath}/`)) entries.delete(entry);
		}
	if (path)
		entries.set(path, { kind, snapshotId: pages[parentDirectories(path).at(-1) ?? ""]?.data?.snapshotId ?? null });
	const removed = new Map(current.scopeKey === scopeKey ? current.removed : []);
	if (removedPath)
		removed.set(removedPath, pages[parentDirectories(removedPath).at(-1) ?? ""]?.data?.snapshotId ?? null);
	if (path) removed.delete(path);
	return { scopeKey, entries, removed };
}

/** Incomplete parent pages are never absence proof for a receipt beyond page one. */
export function reconcileFileTreeMutationReceipts(
	current: FileTreeMutationProjection,
	pages: FileTreeDirectoryPages,
): FileTreeMutationProjection {
	const entries = new Map(current.entries);
	for (const [path, receipt] of entries) {
		const parent = pages[parentDirectories(path).at(-1) ?? ""]?.data;
		if (!parent) continue;
		const listed = parent.files.includes(path) || parent.directories?.includes(path);
		if (listed || (parent.snapshotId !== receipt.snapshotId && parent.nextCursor === null)) entries.delete(path);
	}
	return entries.size === current.entries.size ? current : { ...current, entries };
}
