import type { RuntimeWorkdirChangesMode, RuntimeWorkdirFileChange } from "@/runtime/types";

export interface CachedDiff {
	oldText: string | null;
	newText: string | null;
}

export function buildDiffCacheKey(
	path: string,
	mode: RuntimeWorkdirChangesMode,
	fromRef: string | null | undefined,
	toRef: string | null | undefined,
): string {
	return `${path}::${mode}::${fromRef ?? ""}::${toRef ?? ""}`;
}

export function buildFileMetadataFingerprint(files: RuntimeWorkdirFileChange[]): string {
	return files.map((file) => buildFileMetadataEntry(file)).join("|");
}

export function haveFileContentRevisions(files: RuntimeWorkdirFileChange[]): boolean {
	return files.every((file) => typeof file.contentRevision === "string" && file.contentRevision.length > 0);
}

export function getChangedMetadataPaths(
	previousFiles: RuntimeWorkdirFileChange[] | null,
	nextFiles: RuntimeWorkdirFileChange[],
): Set<string> {
	if (!previousFiles) {
		return new Set(nextFiles.map((file) => file.path));
	}
	const previousEntries = new Map(previousFiles.map((file) => [file.path, buildFileMetadataEntry(file)]));
	const changedPaths = new Set<string>();
	for (const file of nextFiles) {
		if (previousEntries.get(file.path) !== buildFileMetadataEntry(file)) {
			changedPaths.add(file.path);
		}
	}
	return changedPaths;
}

export function mergeFilesWithCachedDiffs(input: {
	files: RuntimeWorkdirFileChange[];
	previousFiles: RuntimeWorkdirFileChange[] | null;
	cache: ReadonlyMap<string, CachedDiff>;
	mode: RuntimeWorkdirChangesMode;
	fromRef: string | null | undefined;
	toRef: string | null | undefined;
}): { files: RuntimeWorkdirFileChange[]; loaded: Set<string> } {
	const previousByPath = new Map((input.previousFiles ?? []).map((file) => [file.path, file]));
	const loaded = new Set<string>();
	const nextFiles = input.files.map((file) => {
		const cacheKey = buildDiffCacheKey(file.path, input.mode, input.fromRef, input.toRef);
		const cached = input.cache.get(cacheKey);
		const previous = previousByPath.get(file.path);
		const oldText = cached ? cached.oldText : (previous?.oldText ?? file.oldText);
		const newText = cached ? cached.newText : (previous?.newText ?? file.newText);
		if (cached) {
			loaded.add(file.path);
		}
		if (previous && areFileEntriesEqual(previous, file, oldText, newText)) {
			return previous;
		}
		return {
			...file,
			oldText,
			newText,
		};
	});
	return { files: nextFiles, loaded };
}

export function applyFileDiff(
	files: RuntimeWorkdirFileChange[] | null,
	path: string,
	diff: CachedDiff,
): RuntimeWorkdirFileChange[] | null {
	if (!files) {
		return files;
	}
	let changed = false;
	const nextFiles = files.map((file) => {
		if (file.path !== path) {
			return file;
		}
		if (file.oldText === diff.oldText && file.newText === diff.newText) {
			return file;
		}
		changed = true;
		return { ...file, oldText: diff.oldText, newText: diff.newText };
	});
	return changed ? nextFiles : files;
}

export function areFileArraysSameReference(
	previousFiles: RuntimeWorkdirFileChange[] | null,
	nextFiles: RuntimeWorkdirFileChange[],
): boolean {
	return (
		previousFiles !== null &&
		previousFiles.length === nextFiles.length &&
		nextFiles.every((file, index) => previousFiles[index] === file)
	);
}

function buildFileMetadataEntry(file: RuntimeWorkdirFileChange): string {
	return [
		file.path,
		file.previousPath ?? "",
		file.status,
		file.additions,
		file.deletions,
		file.contentRevision ?? "",
	].join("\t");
}

function areFileEntriesEqual(
	previous: RuntimeWorkdirFileChange,
	nextMetadata: RuntimeWorkdirFileChange,
	oldText: string | null,
	newText: string | null,
): boolean {
	return (
		previous.path === nextMetadata.path &&
		previous.previousPath === nextMetadata.previousPath &&
		previous.status === nextMetadata.status &&
		previous.additions === nextMetadata.additions &&
		previous.deletions === nextMetadata.deletions &&
		previous.oldText === oldText &&
		previous.newText === newText
	);
}
