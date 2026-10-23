import { listWorkdirDirectoryPage } from "../../src/workdir/workdir-directory-listing";

export interface PagedWorkdirTreeOptions {
	useGitIgnores?: boolean;
	showExcluded?: boolean;
	ref?: string | null;
}

export interface PagedWorkdirTree {
	files: string[];
	directories: string[];
}

/** Test helper: expands every listed directory through the paged browser API. */
export async function listPagedWorkdirTree(
	cwd: string,
	options: PagedWorkdirTreeOptions = {},
): Promise<PagedWorkdirTree> {
	const files: string[] = [];
	const directories: string[] = [];
	const pending = [""];
	for (let index = 0; index < pending.length; index += 1) {
		const directory = pending[index] ?? "";
		let cursor: string | undefined;
		let snapshotId: string | null = null;
		do {
			const page = await listWorkdirDirectoryPage({
				cwd,
				directory,
				cursor,
				showExcluded: options.showExcluded ?? false,
				useGitIgnores: options.useGitIgnores ?? true,
				ref: options.ref ?? null,
			});
			if (snapshotId !== null && page.snapshotId !== snapshotId) {
				throw new Error(`Directory ${directory} restarted while paging.`);
			}
			snapshotId = page.snapshotId;
			files.push(...page.files);
			directories.push(...page.directories);
			pending.push(...page.directories);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
	}
	return { files: files.sort(), directories: directories.sort() };
}

export async function listPagedWorkdirFiles(cwd: string, options: PagedWorkdirTreeOptions = {}): Promise<string[]> {
	return (await listPagedWorkdirTree(cwd, options)).files;
}
