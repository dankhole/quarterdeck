import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Pure path selection shared by the CLI/runtime and the native shell. */
export function getRuntimeHomePathForPlatform(platform: NodeJS.Platform): string {
	const pathApi = platform === "win32" ? win32 : posix;
	const override = process.env.QUARTERDECK_STATE_HOME;
	return override ? pathApi.resolve(override) : pathApi.join(homedir(), ".quarterdeck");
}

export function getRuntimeHomePath(): string {
	return getRuntimeHomePathForPlatform(process.platform);
}
