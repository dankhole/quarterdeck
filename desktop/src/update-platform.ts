import { createHash } from "node:crypto";
import { join } from "node:path";

export function updateControlPath(directory: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32"
		? `\\\\.\\pipe\\quarterdeck-npm-update-${createHash("sha256").update(directory).digest("hex")}`
		: join(directory, "control.sock");
}

export function updateShellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
}
