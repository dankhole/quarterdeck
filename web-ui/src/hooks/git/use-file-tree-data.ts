import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeListFilesResponse, RuntimeWorkdirEntryKind } from "@/runtime/types";
import { createListFilesRequest, type FileBrowserScope } from "./file-browser-scope";
import { FileTreeLoader } from "./file-tree-loader";
import {
	applyFileTreeMutationReceipt,
	type FileTreeDirectoryPages,
	type FileTreeMutationProjection,
	parentDirectories,
	projectFileTree,
	reconcileFileTreeMutationReceipts,
	visibleExpandedDirectories,
} from "./file-tree-pages";

const FILE_LIST_POLL_INTERVAL_MS = 5_000;

export interface UseFileTreeDataResult {
	readonly files: string[] | null;
	readonly directories: string[] | null;
	readonly directoryPages: FileTreeDirectoryPages;
	readonly showExcluded: boolean;
	setShowExcluded: (show: boolean) => void;
	setExpandedDirectories: (directories: ReadonlySet<string>) => void;
	loadDirectory: (directory: string, append?: boolean) => Promise<RuntimeListFilesResponse | null>;
	readonly fileListError: Error | null;
	readonly fileListData: RuntimeListFilesResponse | null;
	reloadFileListForScope: (
		requestScopeKey: string,
		affectedPaths: readonly string[],
	) => Promise<RuntimeListFilesResponse | null>;
	revealEntry: (path: string, kind: RuntimeWorkdirEntryKind, removedPath?: string) => void;
}

export function useFileTreeData(scope: FileBrowserScope): UseFileTreeDataResult {
	const [, publish] = useReducer((value: number) => value + 1, 0);
	const [showExcluded, setShowExcluded] = useState(false);
	const expandedRef = useRef<ReadonlySet<string>>(new Set());
	const [revealed, setRevealed] = useState<FileTreeMutationProjection>({
		scopeKey: scope.contentScopeKey,
		entries: new Map(),
		removed: new Map(),
	});
	const loader = useMemo(
		() =>
			new FileTreeLoader(async (directory, cursor) => {
				if (!scope.projectId) throw new Error("Missing project.");
				return await getRuntimeTrpcClient(scope.projectId).project.listFiles.query({
					...createListFilesRequest(scope),
					directory,
					showExcluded,
					...(cursor ? { cursor } : {}),
				});
			}, publish),
		[scope, showExcluded],
	);
	const loaderRef = useRef(loader);
	loaderRef.current = loader;

	const projected = useMemo(
		() => projectFileTree(loader.pages, revealed, scope.contentScopeKey, showExcluded),
		[loader.pages, revealed, scope.contentScopeKey, showExcluded],
	);
	const projectedDirectoriesRef = useRef(projected.directories);
	projectedDirectoriesRef.current = projected.directories;

	const updateVisible = useCallback(
		(directories: ReadonlySet<string>) => {
			expandedRef.current = directories;
			const loadedDirectories = new Set(projectedDirectoriesRef.current);
			loader.visible = new Set([
				"",
				...visibleExpandedDirectories(directories).filter((directory) => loadedDirectories.has(directory)),
			]);
			for (const directory of loader.visible) {
				const page = loader.pages[directory];
				if (!page || (!page.data && !page.error)) void loader.load(directory);
			}
		},
		[loader],
	);

	useEffect(() => {
		if (!scope.canQueryRuntime) return;
		loader.start();
		updateVisible(expandedRef.current);
		void loader.load("");
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			await Promise.all([...loader.visible].map((directory) => loader.load(directory)));
			if (!disposed) timer = setTimeout(() => void poll(), FILE_LIST_POLL_INTERVAL_MS);
		};
		if (!scope.browseRef) timer = setTimeout(() => void poll(), FILE_LIST_POLL_INTERVAL_MS);
		return () => {
			disposed = true;
			clearTimeout(timer);
			loader.stop();
		};
	}, [loader, scope.canQueryRuntime, scope.browseRef, updateVisible]);

	useEffect(() => {
		if (scope.canQueryRuntime) updateVisible(expandedRef.current);
	}, [loader.pages, revealed, scope.canQueryRuntime, updateVisible]);

	useEffect(() => {
		setRevealed((current) =>
			current.scopeKey === scope.contentScopeKey
				? reconcileFileTreeMutationReceipts(current, loader.pages)
				: current,
		);
	}, [loader.pages, scope.contentScopeKey]);

	const reloadFileListForScope = useCallback(
		async (requestScopeKey: string, affectedPaths: readonly string[]) => {
			if (requestScopeKey !== scope.contentScopeKey || loaderRef.current !== loader) return null;
			const results = await Promise.all(
				[...new Set(affectedPaths.flatMap(parentDirectories))]
					.filter((directory) => directory === "" || loader.pages[directory])
					.map((directory) => loader.refresh(directory)),
			);
			return loaderRef.current === loader ? (results[0] ?? null) : null;
		},
		[loader, scope.contentScopeKey],
	);

	const revealEntry = useCallback(
		(path: string, kind: RuntimeWorkdirEntryKind, removedPath?: string) => {
			setRevealed((current) =>
				applyFileTreeMutationReceipt(current, loader.pages, scope.contentScopeKey, path, kind, removedPath),
			);
		},
		[loader, scope.contentScopeKey],
	);

	const root = loader.pages[""];
	return {
		files: root?.data ? projected.files : null,
		directories: root?.data ? projected.directories : null,
		directoryPages: loader.pages,
		showExcluded,
		setShowExcluded,
		setExpandedDirectories: updateVisible,
		loadDirectory: useCallback((directory: string, append = false) => loader.load(directory, append), [loader]),
		fileListData: root?.data ?? null,
		fileListError: root?.error ?? null,
		reloadFileListForScope,
		revealEntry,
	};
}
