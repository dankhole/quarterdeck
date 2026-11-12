import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privateDirectory from "../../../src/core/private-directory.js";
import {
	installRuntimeWriteAdmission,
	RuntimeWriteAdmissionError,
	waitForRuntimeWriteQuiescence,
} from "../../../src/state/runtime-write-admission.js";
import { cleanupAbandonedPiPromptFiles, createPiPromptDirectory } from "../../../src/terminal/pi-prompt-storage.js";

vi.mock("node:fs/promises", { spy: true });

const ensurePrivateDirectory = privateDirectory.ensurePrivateDirectory;

describe("private Pi prompt storage", () => {
	let temporaryHome: string;
	let stateHome: string;
	let root: string;
	let disposeAdmission: (() => void) | undefined;

	beforeEach(async () => {
		temporaryHome = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "quarterdeck-pi-prompt-storage-")));
		stateHome = join(temporaryHome, "state-home");
		root = join(stateHome, "pi-prompts");
		await fs.mkdir(stateHome);
		vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);
	});

	afterEach(async () => {
		await waitForRuntimeWriteQuiescence(stateHome);
		disposeAdmission?.();
		disposeAdmission = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await fs.rm(temporaryHome, { recursive: true, force: true });
	});

	it("creates distinct empty private launch directories beneath the dedicated state-home root", async () => {
		const first = await createPiPromptDirectory();
		const second = await createPiPromptDirectory();
		expect(first).not.toBe(second);
		expect(dirname(first)).toBe(root);
		expect(dirname(second)).toBe(root);
		expect(basename(first)).toMatch(/^launch-/u);
		expect(await fs.readdir(first)).toEqual([]);
		if (process.platform !== "win32") {
			for (const path of [root, first, second]) expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
		}
	});

	it("creates an absent state home for standalone launch preparation", async () => {
		await fs.rm(stateHome, { recursive: true });
		const directory = await createPiPromptDirectory();
		expect(dirname(directory)).toBe(root);
		if (process.platform !== "win32") expect((await fs.stat(stateHome)).mode & 0o777).toBe(0o700);
	});

	it("removes its own empty child if private child preparation fails", async () => {
		vi.spyOn(privateDirectory, "ensurePrivateDirectory").mockImplementation(async (path) => {
			if (path !== root) throw new Error(`private child path: ${path}`);
			await ensurePrivateDirectory(path);
		});
		await expect(createPiPromptDirectory()).rejects.toThrow("Could not prepare private Pi prompt storage");
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("removes its own empty child if the lease is revoked during private child preparation", async () => {
		let current = true;
		disposeAdmission = installRuntimeWriteAdmission({ canonicalStateHome: stateHome, isCurrent: () => current });
		vi.spyOn(privateDirectory, "ensurePrivateDirectory").mockImplementation(async (path) => {
			await ensurePrivateDirectory(path);
			if (path !== root) current = false;
		});
		await expect(createPiPromptDirectory()).rejects.toBeInstanceOf(RuntimeWriteAdmissionError);
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("repairs an existing permissive root before protecting a new launch directory", async () => {
		await fs.mkdir(root, { mode: 0o755 });
		const directory = await createPiPromptDirectory();
		if (process.platform !== "win32") {
			expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		}
	});

	it("uses the canonical state home when its configured path is an alias", async () => {
		const alias = join(temporaryHome, "state-home-alias");
		await fs.symlink(stateHome, alias, process.platform === "win32" ? "junction" : "dir");
		vi.stubEnv("QUARTERDECK_STATE_HOME", alias);
		expect(dirname(await createPiPromptDirectory())).toBe(root);
	});

	it("rejects an existing symlink root without changing its target", async () => {
		const target = join(temporaryHome, "unrelated");
		await fs.mkdir(target, { mode: 0o755 });
		await fs.writeFile(join(target, "keep.txt"), "unrelated file");
		const mode = (await fs.stat(target)).mode;
		await fs.symlink(target, root, process.platform === "win32" ? "junction" : "dir");
		await expect(createPiPromptDirectory()).rejects.toThrow("Could not prepare private Pi prompt storage");
		expect(await fs.readdir(target)).toEqual(["keep.txt"]);
		expect((await fs.stat(target)).mode).toBe(mode);
		expect(await fs.readFile(join(target, "keep.txt"), "utf8")).toBe("unrelated file");
	});

	it("rejects a non-directory root with a content-free error", async () => {
		await fs.writeFile(root, "private prompt content");
		const error: unknown = await createPiPromptDirectory().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(stateHome);
		expect(String(error)).not.toContain("private prompt content");
		expect(error).not.toHaveProperty("cause");
		expect(await fs.readFile(root, "utf8")).toBe("private prompt content");
	});

	it("removes abandoned launch files only from the requested state home's dedicated root", async () => {
		const launch = await createPiPromptDirectory();
		await fs.writeFile(join(launch, "prompt.txt"), "private prompt");
		await fs.writeFile(join(stateHome, "board.json"), "keep board");
		const otherHome = join(temporaryHome, "other-home");
		const otherRoot = join(otherHome, "pi-prompts");
		await fs.mkdir(otherRoot, { recursive: true });
		await fs.writeFile(join(otherRoot, "prompt.txt"), "keep another home's prompt");
		await fs.symlink(otherRoot, join(launch, "external"), process.platform === "win32" ? "junction" : "dir");
		// An explicit state home must not accidentally sweep the configured one.
		vi.stubEnv("QUARTERDECK_STATE_HOME", otherHome);
		await cleanupAbandonedPiPromptFiles(stateHome);
		await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(join(stateHome, "board.json"), "utf8")).toBe("keep board");
		expect(await fs.readFile(join(otherRoot, "prompt.txt"), "utf8")).toBe("keep another home's prompt");
	});

	it("unlinks a symlink root without sweeping the target", async () => {
		const target = join(temporaryHome, "unrelated");
		await fs.mkdir(target);
		await fs.writeFile(join(target, "keep.txt"), "unrelated file");
		await fs.symlink(target, root, process.platform === "win32" ? "junction" : "dir");
		await cleanupAbandonedPiPromptFiles();
		await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(join(target, "keep.txt"), "utf8")).toBe("unrelated file");
	});

	it("allows repeated cleanup when the prompt root is absent", async () => {
		await cleanupAbandonedPiPromptFiles();
		await cleanupAbandonedPiPromptFiles();
		expect(await fs.readdir(stateHome)).toEqual([]);
	});

	it("fences creation and deletion when the installed runtime lease is no longer current", async () => {
		const launch = await createPiPromptDirectory();
		await fs.writeFile(join(launch, "prompt.txt"), "keep private prompt");
		disposeAdmission = installRuntimeWriteAdmission({ canonicalStateHome: stateHome, isCurrent: () => false });
		await expect(createPiPromptDirectory()).rejects.toBeInstanceOf(RuntimeWriteAdmissionError);
		await expect(cleanupAbandonedPiPromptFiles()).rejects.toBeInstanceOf(RuntimeWriteAdmissionError);
		expect(await fs.readdir(root)).toEqual([basename(launch)]);
		expect(await fs.readFile(join(launch, "prompt.txt"), "utf8")).toBe("keep private prompt");
	});

	it("drains admitted preparation and rechecks ownership after asynchronous privacy work", async () => {
		let current = true;
		disposeAdmission = installRuntimeWriteAdmission({ canonicalStateHome: stateHome, isCurrent: () => current });
		let allowPrivacy!: () => void;
		const privacyGate = new Promise<void>((resolve) => (allowPrivacy = resolve));
		const protecting = vi.spyOn(privateDirectory, "ensurePrivateDirectory").mockImplementationOnce(async (path) => {
			await privacyGate;
			await ensurePrivateDirectory(path);
		});
		const creating = createPiPromptDirectory();
		const rejected = expect(creating).rejects.toBeInstanceOf(RuntimeWriteAdmissionError);
		let drained = false;
		try {
			await vi.waitFor(() => expect(protecting).toHaveBeenCalledOnce());
			const draining = waitForRuntimeWriteQuiescence(stateHome).then(() => {
				drained = true;
			});
			await Promise.resolve();
			expect(drained).toBe(false);
			current = false;
			allowPrivacy();
			await rejected;
			await draining;
			expect(await fs.readdir(root)).toEqual([]);
		} finally {
			current = false;
			allowPrivacy();
			await creating.catch(() => undefined);
		}
	});

	it("rechecks write admission immediately before deleting the root", async () => {
		const launch = await createPiPromptDirectory();
		const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
		disposeAdmission = installRuntimeWriteAdmission({ canonicalStateHome: stateHome, isCurrent });
		await expect(cleanupAbandonedPiPromptFiles()).rejects.toBeInstanceOf(RuntimeWriteAdmissionError);
		expect(await fs.readdir(root)).toEqual([basename(launch)]);
	});

	it("fails closed with user action and no private filesystem error details", async () => {
		await createPiPromptDirectory();
		vi.mocked(fs.rm).mockRejectedValueOnce(new Error(`private prompt path: ${root}/secret.txt`));
		const error: unknown = await cleanupAbandonedPiPromptFiles().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("restart Quarterdeck");
		expect(String(error)).not.toContain(stateHome);
		expect(String(error)).not.toContain("secret.txt");
		expect(error).not.toHaveProperty("cause");
		expect(await fs.stat(root)).toBeDefined();
	});
});
