/** Fixed desktop recovery backing identity; no draft content or privileged storage API. */
export const FILE_EDITOR_RECOVERY_DATABASE = "quarterdeck.desktop.file-recovery";
export const FILE_EDITOR_RECOVERY_DATABASE_VERSION = 1;
export const FILE_EDITOR_RECOVERY_OBJECT_STORE = "snapshots";
export const FILE_EDITOR_RECOVERY_SNAPSHOT_KEY = "file-drafts.v1";

/** Scope identities are absolute paths supplied by the runtime on either host platform. */
export function isFileEditorRecoveryRootPath(path: string): boolean {
	return path.startsWith("/") || /^[a-z]:[/\\]/iu.test(path) || /^\\\\[^\\/.][^\\/]*\\[^\\/]+/u.test(path);
}
