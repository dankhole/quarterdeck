import { useEffect, useSyncExternalStore } from "react";
import {
	connectDesktopFileEditorRecovery,
	getDesktopFileEditorRecoveryCommitStatus,
	resetDesktopFileEditorRecovery,
	retryDesktopFileEditorRecovery,
} from "./desktop-file-editor-recovery";
import { getFileEditorCacheRevision, subscribeFileEditorCache } from "./file-editor-cache";
import type { FileEditorRecoveryCommitStatus } from "./file-editor-recovery-storage";

export interface UseDesktopFileEditorRecoveryResult {
	readonly commitStatus: FileEditorRecoveryCommitStatus;
	retryRecovery: () => Promise<boolean>;
	resetRecovery: () => Promise<boolean>;
}

/** app://quarterdeck recovery belongs to the main-selected persistent userData profile. */
export function useDesktopFileEditorRecovery(): UseDesktopFileEditorRecoveryResult {
	useEffect(connectDesktopFileEditorRecovery, []);
	useSyncExternalStore(subscribeFileEditorCache, getFileEditorCacheRevision);
	return {
		commitStatus: getDesktopFileEditorRecoveryCommitStatus(),
		retryRecovery: retryDesktopFileEditorRecovery,
		resetRecovery: resetDesktopFileEditorRecovery,
	};
}
