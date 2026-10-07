import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(desktopRoot, "..");

export function resolveTargetArch(arch = process.arch) {
	if (arch !== "arm64" && arch !== "x64") {
		throw new Error("Desktop packaging supports only native macOS arm64 and x64 targets.");
	}
	return arch;
}

export function requireNativeMacTarget(arch) {
	resolveTargetArch(arch);
	if (process.platform !== "darwin" || arch !== process.arch) {
		throw new Error(
			`Build and validate ${arch} on a native ${arch} macOS runner; cross-compiled PTYs are not a verified target.`,
		);
	}
}

export function stagedRuntimePath(arch) {
	return join(desktopRoot, ".stage", resolveTargetArch(arch), "runtime");
}
