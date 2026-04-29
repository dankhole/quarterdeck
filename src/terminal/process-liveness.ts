export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM means the process exists but we lack permission — it's alive.
		// ESRCH means no such process — it's dead.
		// This distinction matters on Windows where access-denied is common.
		if (typeof error === "object" && error !== null && "code" in error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		}
		return false;
	}
}
