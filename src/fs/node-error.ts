/** Type-safe check for Node.js system errors (ENOENT, EACCES, etc.). */
export function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
