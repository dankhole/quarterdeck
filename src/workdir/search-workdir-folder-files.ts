import { join } from "node:path";

import type { RuntimeWorkdirFileSearchMatch } from "../core";
import { searchFilePaths } from "./search-workdir-files";
import { isBrowseExcludedChildDirectory } from "./workdir-browse-policy";
import {
	openDirectoryChildSource,
	openWorkdirDirectorySource,
	type WorkdirDirectoryChildSource,
} from "./workdir-directory-source";

/**
 * Search work budget. It bounds one query's scan, never what the browser may navigate.
 * Results are partial (`truncated`) when any budget stops the scan early.
 */
export interface FolderFileSearchBudget {
	readonly maxExaminedEntries: number;
	readonly maxDurationMs: number;
	/** Matching paths retained for ranking; reaching it stops the scan. */
	readonly maxCandidates: number;
}

export const FOLDER_FILE_SEARCH_BUDGET: FolderFileSearchBudget = {
	maxExaminedEntries: 100_000,
	maxDurationMs: 2_000,
	maxCandidates: 2_000,
};

export interface FolderFileSearchResult {
	readonly files: RuntimeWorkdirFileSearchMatch[];
	readonly truncated: boolean;
}

/**
 * Streams a breadth-first filesystem scan for folder projects: no Git, no cached file
 * list, skipped VCS/dependency directories and generated agent worktrees excluded.
 * Directories are enumerated one at a time through the shared filesystem gate.
 */
export async function searchFolderWorkdirFiles(
	cwd: string,
	query: string,
	limit: number | undefined,
	budget: FolderFileSearchBudget = FOLDER_FILE_SEARCH_BUDGET,
): Promise<FolderFileSearchResult> {
	const queryLower = query.trim().toLowerCase();
	const deadline = Date.now() + budget.maxDurationMs;
	const candidates: string[] = [];
	const pendingDirectories: string[] = [""];
	let examined = 0;
	let truncated = false;

	scan: for (let index = 0; index < pendingDirectories.length; index += 1) {
		// Checked before each open too, so repeatedly failing opens cannot bypass the budget.
		if (examined >= budget.maxExaminedEntries || Date.now() >= deadline) {
			truncated = true;
			break;
		}
		const directory = pendingDirectories[index] ?? "";
		// Release the queue prefix so a long scan's memory tracks only unvisited directories.
		pendingDirectories[index] = "";
		let source: WorkdirDirectoryChildSource;
		try {
			source = directory
				? await openDirectoryChildSource(join(cwd, directory))
				: await openWorkdirDirectorySource(cwd, "");
		} catch (error) {
			// The root must be searchable; descendants removed or unreadable mid-scan are skipped.
			if (!directory) throw error;
			continue;
		}
		try {
			while (true) {
				if (examined >= budget.maxExaminedEntries || Date.now() >= deadline) {
					truncated = true;
					break scan;
				}
				const child = await source.next();
				if (!child) break;
				examined += 1;
				const path = directory ? `${directory}/${child.name}` : child.name;
				if (child.isDirectory) {
					if (!isBrowseExcludedChildDirectory(directory, child.name, { showExcluded: false })) {
						pendingDirectories.push(path);
					}
					continue;
				}
				// Every ranked match contains the query somewhere in its path.
				if (queryLower && !path.toLowerCase().includes(queryLower)) continue;
				candidates.push(path);
				if (candidates.length >= budget.maxCandidates) {
					truncated = true;
					break scan;
				}
			}
		} finally {
			await source.close();
		}
	}
	return { files: searchFilePaths(candidates, query, limit), truncated };
}
