import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MakerWindowsZip } from "../scripts/maker-windows-zip.mjs";
import { withExtractedWindowsArchive } from "../scripts/verify-windows-archive.mjs";

it.skipIf(process.platform !== "win32")(
	"extracts Forge ZIP files beyond MAX_PATH with the installer decoder",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-zip-"));
		try {
			const dir = join(root, "Quarterdeck-win32-x64");
			const components = ["host", "resources", "a".repeat(110), "b".repeat(110)];
			const folder = join(dir, ...components);
			const payload = join(folder, "fixture.txt");
			expect(payload.length).toBeGreaterThan(260);
			await mkdir(folder, { recursive: true });
			await writeFile(payload, "Quarterdeck ZIP fixture");
			const [archive] = await new MakerWindowsZip({}).make({
				dir,
				makeDir: join(root, "make"),
				packageJSON: { version: "1.0.0" },
				targetArch: "x64",
			});
			await withExtractedWindowsArchive(archive, async (appPath) => {
				const extracted = join(appPath, ...components, "fixture.txt");
				expect(extracted.length).toBeGreaterThan(260);
				expect(await readFile(extracted, "utf8")).toBe("Quarterdeck ZIP fixture");
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	15_000,
);
