import { cpSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MakerDMG } from "../scripts/maker-dmg.mjs";
import { run } from "../scripts/process.mjs";

vi.mock("../scripts/process.mjs", () => ({ run: vi.fn() }));
vi.mock("../scripts/paths.mjs", () => ({ requireNativeMacTarget: vi.fn() }));

const roots = [];
afterEach(async () => {
	vi.resetAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-dmg-test-"));
	roots.push(root);
	const dir = join(root, "package with spaces");
	const app = join(dir, "Quarterdeck.app");
	await mkdir(app, { recursive: true });
	await writeFile(join(app, "executable"), "signed app fixture");
	await chmod(join(app, "executable"), 0o755);
	await symlink("executable", join(app, "relative-link"));
	const makeDir = join(root, "make");
	const outputDirectory = join(makeDir, "dmg", "arm64");
	await mkdir(outputDirectory, { recursive: true });
	const output = join(outputDirectory, "Quarterdeck-1.2.3-arm64.dmg");
	await writeFile(output, "previous valid image");
	const maker = new MakerDMG({ name: "Quarterdeck-1.2.3-arm64" }).clone();
	await maker.prepareConfig("arm64");
	return {
		maker,
		output,
		outputDirectory,
		options: { dir, makeDir, appName: "Quarterdeck", packageJSON: { version: "1.2.3" }, targetArch: "arm64" },
	};
}

function nativeCommands(failAt) {
	vi.mocked(run).mockImplementation((command, args) => {
		if (command === "/usr/bin/ditto") {
			cpSync(args[0], args[1], { recursive: true, verbatimSymlinks: true });
			return;
		}
		if (args[0] === "create") {
			const source = args[args.indexOf("-srcfolder") + 1];
			expect(readlinkSync(join(source, "Applications"))).toBe("/Applications");
			expect(readlinkSync(join(source, "Quarterdeck.app", "relative-link"))).toBe("executable");
			expect(statSync(join(source, "Quarterdeck.app", "executable")).mode & 0o777).toBe(0o755);
			writeFileSync(args.at(-1), "new image");
		}
		if (args[0] === failAt) throw new Error(`Native ${failAt} failed`);
	});
}

describe("native DMG maker", () => {
	it("publishes the verified image with the configured Forge name and removes staging", async () => {
		const f = await fixture();
		nativeCommands();
		expect(await f.maker.make(f.options)).toEqual([f.output]);
		expect(await readFile(f.output, "utf8")).toBe("new image");
		expect(await readdir(f.outputDirectory)).toEqual(["Quarterdeck-1.2.3-arm64.dmg"]);
		expect(vi.mocked(run).mock.calls.at(-1)[1][0]).toBe("verify");
	});

	it.each(["create", "verify"])("retains the prior artifact and removes staging when %s fails", async (stage) => {
		const f = await fixture();
		nativeCommands(stage);
		await expect(f.maker.make(f.options)).rejects.toThrow(`Native ${stage} failed`);
		expect(await readFile(f.output, "utf8")).toBe("previous valid image");
		expect(await readdir(f.outputDirectory)).toEqual(["Quarterdeck-1.2.3-arm64.dmg"]);
	});
});
