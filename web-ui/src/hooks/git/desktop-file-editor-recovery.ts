import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import { createFileEditorRecoveryIndexedDB, type FileEditorRecoveryIndexedDB } from "./file-editor-recovery-indexed-db";
import {
	connectFileEditorRecoveryStorage,
	type FileEditorRecoveryCommitStatus,
	flushFileEditorRecoveryStorage,
	getFileEditorRecoveryCommitStatus,
	resetFileEditorRecoveryStorage,
	retryFileEditorRecoveryStorage,
} from "./file-editor-recovery-storage";

// The renderer session owns one adapter even when the recovery UI remounts.
// Detaching a hook must not replace an adapter with a pending strict transaction.
let storage: FileEditorRecoveryIndexedDB | undefined;

export function connectDesktopFileEditorRecovery(): () => void {
	if (getRuntimeEnvironment().kind !== "desktop") return () => {};
	storage ??= createFileEditorRecoveryIndexedDB();
	return connectFileEditorRecoveryStorage(storage, Date.now, {
		getItem: (key) => window.localStorage.getItem(key),
		removeItem: (key) => window.localStorage.removeItem(key),
	});
}

export function getDesktopFileEditorRecoveryCommitStatus(): FileEditorRecoveryCommitStatus {
	if (getRuntimeEnvironment().kind !== "desktop")
		return {
			loaded: true,
			pending: false,
			busy: false,
			problem: null,
			desiredRevision: 0,
			committedRevision: 0,
			ready: true,
		};
	return storage
		? getFileEditorRecoveryCommitStatus(storage)
		: {
				loaded: false,
				pending: true,
				busy: false,
				problem: null,
				desiredRevision: 0,
				committedRevision: 0,
				ready: false,
			};
}

export async function flushDesktopFileEditorRecovery(): Promise<boolean> {
	if (getRuntimeEnvironment().kind !== "desktop") return true;
	return storage ? flushFileEditorRecoveryStorage(storage) : false;
}

export async function retryDesktopFileEditorRecovery(): Promise<boolean> {
	if (getRuntimeEnvironment().kind !== "desktop" || !storage) return false;
	return retryFileEditorRecoveryStorage(storage);
}

export async function resetDesktopFileEditorRecovery(): Promise<boolean> {
	if (getRuntimeEnvironment().kind !== "desktop" || !storage) return false;
	return resetFileEditorRecoveryStorage(storage);
}
