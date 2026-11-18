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
	storage ??= createFileEditorRecoveryIndexedDB();
	return connectFileEditorRecoveryStorage(storage, Date.now, {
		getItem: (key) => window.localStorage.getItem(key),
		removeItem: (key) => window.localStorage.removeItem(key),
	});
}

export function getDesktopFileEditorRecoveryCommitStatus(): FileEditorRecoveryCommitStatus {
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
	return storage ? flushFileEditorRecoveryStorage(storage) : false;
}

export async function retryDesktopFileEditorRecovery(): Promise<boolean> {
	return storage ? retryFileEditorRecoveryStorage(storage) : false;
}

export async function resetDesktopFileEditorRecovery(): Promise<boolean> {
	return storage ? resetFileEditorRecoveryStorage(storage) : false;
}
