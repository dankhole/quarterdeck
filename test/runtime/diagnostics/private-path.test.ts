import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	copyPrivateDiagnosticFile,
	DiagnosticAclError,
	ensurePrivateDiagnosticDirectories,
	ensurePrivateDiagnosticDirectory,
} from "../../../src/diagnostics";

describe("private diagnostic directories", () => {
	const temporaryRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
	});

	async function createTemporaryRoot(): Promise<string> {
		const path = await mkdtemp(join(tmpdir(), "quarterdeck-private-diagnostics-"));
		temporaryRoots.push(path);
		return path;
	}

	it.skipIf(process.platform === "win32")("keeps POSIX diagnostic directories owner-only", async () => {
		const root = await createTemporaryRoot();
		const path = join(root, "existing");
		await mkdir(path, { mode: 0o755 });

		await ensurePrivateDiagnosticDirectory(path, { platform: "linux" });

		expect((await stat(path)).mode & 0o777).toBe(0o700);
	});

	it("creates all Windows paths before applying one ACL operation", async () => {
		const root = await createTemporaryRoot();
		const paths = [join(root, "state", "diagnostics"), join(root, "exported bundle")];
		const calls: string[][] = [];

		await ensurePrivateDiagnosticDirectories(paths, {
			platform: "win32",
			runWindowsAclCommand: async (receivedPaths) => {
				calls.push([...receivedPaths]);
				for (const path of receivedPaths) expect((await stat(path)).isDirectory()).toBe(true);
				return { ok: true };
			},
		});

		expect(calls).toEqual([paths]);
	});

	it("fails closed when Windows cannot install the private DACL", async () => {
		const root = await createTemporaryRoot();

		await expect(
			ensurePrivateDiagnosticDirectory(join(root, "diagnostics"), {
				platform: "win32",
				runWindowsAclCommand: async () => ({ ok: false }),
			}),
		).rejects.toBeInstanceOf(DiagnosticAclError);
	});

	it.skipIf(process.platform === "win32")(
		"creates copied evidence beneath the destination ACL instead of preserving source permissions",
		async () => {
			const root = await createTemporaryRoot();
			const source = join(root, "source.txt");
			const destinationDirectory = join(root, "private");
			const destination = join(destinationDirectory, "copied.txt");
			await writeFile(source, "private evidence\n", { encoding: "utf8", mode: 0o644 });
			await ensurePrivateDiagnosticDirectory(destinationDirectory, { platform: "linux" });

			await copyPrivateDiagnosticFile(source, destination);

			expect(await readFile(destination, "utf8")).toBe("private evidence\n");
			expect((await stat(destination)).mode & 0o777).toBe(0o600);
		},
	);
});
