import type { WorkdirDirectoryChildSource } from "./workdir-directory-source";

export interface WorkdirDirectoryPageLimits {
	/** Maximum files plus directories returned. */
	readonly maxVisibleEntries: number;
	/** Maximum children read from the source, including hidden ones. */
	readonly maxExaminedEntries: number;
}

export interface WorkdirDirectoryPageFilters {
	/** Synchronous view policy for a child directory name. */
	isExcludedDirectory(name: string): boolean;
	/** Optional batched check of surviving child directory paths; returns paths to hide. */
	findHiddenDirectories?(paths: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface WorkdirDirectoryPageContent {
	readonly files: string[];
	readonly directories: string[];
	readonly hiddenCount: number;
	readonly exhausted: boolean;
}

function childPath(directory: string, name: string): string {
	return directory ? `${directory}/${name}` : name;
}

/**
 * Reads the next bounded chunk of immediate children from `source` and applies view
 * filters. A page can be empty but unexhausted when filters hide its whole chunk.
 */
export async function readWorkdirDirectoryPage(
	source: WorkdirDirectoryChildSource,
	directory: string,
	limits: WorkdirDirectoryPageLimits,
	filters: WorkdirDirectoryPageFilters,
): Promise<WorkdirDirectoryPageContent> {
	const files: string[] = [];
	let directories: string[] = [];
	let hiddenCount = 0;
	let examined = 0;
	let exhausted = false;
	while (examined < limits.maxExaminedEntries && files.length + directories.length < limits.maxVisibleEntries) {
		const child = await source.next();
		if (!child) {
			exhausted = true;
			break;
		}
		examined += 1;
		const path = childPath(directory, child.name);
		if (!child.isDirectory) files.push(path);
		else if (filters.isExcludedDirectory(child.name)) hiddenCount += 1;
		else directories.push(path);
	}
	if (filters.findHiddenDirectories && directories.length > 0) {
		const hidden = await filters.findHiddenDirectories(directories);
		if (hidden.size > 0) {
			const visible = directories.filter((path) => !hidden.has(path));
			hiddenCount += directories.length - visible.length;
			directories = visible;
		}
	}
	return { files, directories, hiddenCount, exhausted };
}
