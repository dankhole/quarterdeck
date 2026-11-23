import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MakerWindowsZip } from "../scripts/maker-windows-zip.mjs";

it.skipIf(process.platform !== "win32")(
	"archives files beyond MAX_PATH using installer-relative entry names",
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
			const entry = [...components, "fixture.txt"].join("/");
			const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
			const listing = execFileSync(tar, ["-tf", archive], { encoding: "utf8", windowsHide: true });
			expect(listing.split(/\r?\n/u)).toContain(entry);
			expect(execFileSync(tar, ["-xOf", archive, entry], { encoding: "utf8", windowsHide: true })).toBe(
				"Quarterdeck ZIP fixture",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
