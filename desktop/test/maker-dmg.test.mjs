import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MakerDMG } from "../scripts/maker-dmg.mjs";

vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal()), spawn: vi.fn() }));
vi.mock("../scripts/paths.mjs", () => ({ requireNativeMacTarget: vi.fn() }));

const stages = ["ditto", "create", "verify"];
const durationMs = 25;
const roots = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.mocked(spawn).mockReset();
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

function startTiming(stage) {
	return `[desktop timing] dmg.${stage}: start`;
}

function stageTimings(stage, outcome) {
	return [startTiming(stage), `[desktop timing] dmg.${stage}: ${outcome} (${durationMs} ms)`];
}

function nativeCommands({ failure, verification } = {}) {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.mocked(spawn).mockImplementation((command, args, options) => {
		const stage = command === "/usr/bin/ditto" ? "ditto" : args[0];
		expect(log).toHaveBeenLastCalledWith(startTiming(stage));
		expect(options).toEqual({ stdio: "inherit" });
		if (stage === "ditto") {
			cpSync(args[0], args[1], { recursive: true, verbatimSymlinks: true });
		} else {
			expect(command).toBe("/usr/bin/hdiutil");
			if (stage === "create") {
				const source = args[args.indexOf("-srcfolder") + 1];
				expect(readlinkSync(join(source, "Applications"))).toBe("/Applications");
				expect(readlinkSync(join(source, "Quarterdeck.app", "relative-link"))).toBe("executable");
				expect(statSync(join(source, "Quarterdeck.app", "executable")).mode & 0o777).toBe(0o755);
				writeFileSync(args.at(-1), "new image");
			}
		}
		const child = new EventEmitter();
		const finish = () => {
			now += durationMs;
			if (stage === failure?.stage) failure.finish(child);
			else child.emit("close", 0, null);
		};
		if (stage === "verify" && verification) {
			verification.resolve({ image: args[1], child, finish });
		} else {
			queueMicrotask(finish);
		}
		return child;
	});
	return log;
}

describe("native DMG maker", () => {
	it("atomically replaces the prior image only after verification closes and removes staging", async () => {
		const f = await fixture();
		const verification = Promise.withResolvers();
		const log = nativeCommands({ verification });
		const making = f.maker.make(f.options);
		const { image, child, finish } = await Promise.race([
			verification.promise,
			making.then(() => {
				throw new Error("DMG was published without verification");
			}),
		]);
		let stagedInode;
		let published;
		try {
			child.emit("exit", 0, null);
			expect(await readFile(f.output, "utf8")).toBe("previous valid image");
			expect(await readFile(image, "utf8")).toBe("new image");
			stagedInode = (await stat(image)).ino;
			expect(log.mock.calls.flat()).toEqual([
				...stageTimings("ditto", "success"),
				...stageTimings("create", "success"),
				startTiming("verify"),
			]);
		} finally {
			finish();
			published = await making;
		}
		expect(published).toEqual([f.output]);
		expect(await readFile(f.output, "utf8")).toBe("new image");
		expect((await stat(f.output)).ino).toBe(stagedInode);
		expect(await readdir(f.outputDirectory)).toEqual(["Quarterdeck-1.2.3-arm64.dmg"]);
		expect(log.mock.calls.flat()).toEqual(stages.flatMap((stage) => stageTimings(stage, "success")));
	});

	it.each([
		{
			stage: "ditto",
			finish: (child) => child.emit("error", new Error("Could not spawn ditto")),
			message: "Could not spawn ditto",
		},
		{
			stage: "create",
			finish: (child) => child.emit("close", 1, null),
			message: "/usr/bin/hdiutil exited with code 1.",
		},
		{
			stage: "verify",
			finish: (child) => child.emit("close", null, "SIGTERM"),
			message: "/usr/bin/hdiutil terminated by SIGTERM.",
		},
	])("retains the prior artifact, removes staging and logs failure when $stage fails", async (failure) => {
		const f = await fixture();
		const log = nativeCommands({ failure });
		await expect(f.maker.make(f.options)).rejects.toThrow(failure.message);
		expect(await readFile(f.output, "utf8")).toBe("previous valid image");
		expect(await readdir(f.outputDirectory)).toEqual(["Quarterdeck-1.2.3-arm64.dmg"]);
		expect(log.mock.calls.flat()).toEqual([
			...stages.slice(0, stages.indexOf(failure.stage)).flatMap((stage) => stageTimings(stage, "success")),
			...stageTimings(failure.stage, "failure"),
		]);
	});
});
