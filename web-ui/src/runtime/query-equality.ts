import type { RuntimeGitRefsResponse, RuntimeListFilesResponse, RuntimeWorkdirChangesResponse } from "@/runtime/types";

function haveWorkdirContentRevisions(data: RuntimeWorkdirChangesResponse): boolean {
	return data.files.every((file) => typeof file.contentRevision === "string" && file.contentRevision.length > 0);
}

export function areWorkdirChangesRevisionsEqual(
	previousData: RuntimeWorkdirChangesResponse,
	nextData: RuntimeWorkdirChangesResponse,
): boolean {
	if (previousData.repoRoot !== nextData.repoRoot) {
		return false;
	}
	if (
		previousData.generatedAt !== nextData.generatedAt &&
		(!haveWorkdirContentRevisions(previousData) || !haveWorkdirContentRevisions(nextData))
	) {
		return false;
	}
	if (previousData.files.length !== nextData.files.length) {
		return false;
	}
	for (let index = 0; index < previousData.files.length; index += 1) {
		const previousFile = previousData.files[index];
		const nextFile = nextData.files[index];
		if (
			!previousFile ||
			!nextFile ||
			previousFile.path !== nextFile.path ||
			previousFile.previousPath !== nextFile.previousPath ||
			previousFile.status !== nextFile.status ||
			previousFile.additions !== nextFile.additions ||
			previousFile.deletions !== nextFile.deletions ||
			previousFile.contentRevision !== nextFile.contentRevision ||
			(previousFile.oldText?.length ?? null) !== (nextFile.oldText?.length ?? null) ||
			(previousFile.newText?.length ?? null) !== (nextFile.newText?.length ?? null)
		) {
			return false;
		}
	}
	return true;
}

function areStringArraysEqual(previousValues: readonly string[], nextValues: readonly string[]): boolean {
	if (previousValues.length !== nextValues.length) {
		return false;
	}
	for (let index = 0; index < previousValues.length; index += 1) {
		if (previousValues[index] !== nextValues[index]) {
			return false;
		}
	}
	return true;
}

export function areListFilesResponsesEqual(
	previousData: RuntimeListFilesResponse,
	nextData: RuntimeListFilesResponse,
): boolean {
	return (
		previousData.mutable === nextData.mutable &&
		previousData.mutationBlockedReason === nextData.mutationBlockedReason &&
		areStringArraysEqual(previousData.files, nextData.files) &&
		areStringArraysEqual(previousData.directories ?? [], nextData.directories ?? [])
	);
}

export function areGitRefsResponsesEqual(
	previousData: RuntimeGitRefsResponse,
	nextData: RuntimeGitRefsResponse,
): boolean {
	if (previousData.ok !== nextData.ok || previousData.error !== nextData.error) {
		return false;
	}
	if (previousData.refs.length !== nextData.refs.length) {
		return false;
	}
	for (let index = 0; index < previousData.refs.length; index += 1) {
		const previousRef = previousData.refs[index];
		const nextRef = nextData.refs[index];
		if (
			!previousRef ||
			!nextRef ||
			previousRef.name !== nextRef.name ||
			previousRef.type !== nextRef.type ||
			previousRef.hash !== nextRef.hash ||
			previousRef.isHead !== nextRef.isHead ||
			previousRef.upstreamName !== nextRef.upstreamName ||
			previousRef.ahead !== nextRef.ahead ||
			previousRef.behind !== nextRef.behind
		) {
			return false;
		}
	}
	return true;
}
