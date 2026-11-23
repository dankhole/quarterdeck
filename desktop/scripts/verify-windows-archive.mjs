import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Use the installer decoder on a disposable tree, without installing or launching it. */
export async function withExtractedWindowsArchive(archive, verify) {
	const { tsImport } = await import("tsx/esm/api");
	const { extractWindowsDesktopArchive } = await tsImport(
		"../../src/desktop-install/windows-archive.ts",
		import.meta.url,
	);
	const temporary = await mkdtemp(join(tmpdir(), "qdeck-zip-"));
	try {
		const appPath = join(temporary, "app");
		await extractWindowsDesktopArchive(archive, appPath);
		await verify(appPath);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
