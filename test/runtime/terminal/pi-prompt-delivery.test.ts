import * as fs from "node:fs/promises";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installRuntimeWriteAdmission, RuntimeWriteAdmissionError } from "../../../src/state/runtime-write-admission";
import {
	PI_FILE_PROMPT_INSTRUCTION,
	PI_INLINE_PROMPT_MAX_BYTES,
	PI_PROMPT_MAX_BYTES,
	PI_WINDOWS_INLINE_PROMPT_MAX_BYTES,
	preparePiPromptDelivery,
} from "../../../src/terminal/pi-prompt-delivery";
import * as promptStorage from "../../../src/terminal/pi-prompt-storage";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../../../src/terminal/pi-prompt-storage", () => ({
	createPiPromptDirectory: vi.fn(async () => await fs.mkdtemp(join(os.tmpdir(), "quarterdeck-pi-prompt-test-"))),
}));

const cleanups: Array<() => Promise<void>> = [];
const admissionDisposals: Array<() => void> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	vi.resetAllMocks();
	for (const dispose of admissionDisposals.splice(0)) dispose();
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function promptPath(args: string[]): string {
	expect(args).toHaveLength(2);
	expect(args[0]).toMatch(/^@file:\/\//u);
	expect(args[1]).toBe(PI_FILE_PROMPT_INSTRUCTION);
	return fileURLToPath((args[0] ?? "").slice(1));
}

async function prepareFile(prompt: string, options: { platform?: NodeJS.Platform } = {}) {
	const delivery = await preparePiPromptDelivery(prompt, options);
	if (!delivery.cleanup) throw new Error("Expected file-delivery cleanup");
	cleanups.push(delivery.cleanup);
	return { ...delivery, cleanup: delivery.cleanup, path: promptPath(delivery.args) };
}

async function createAdmittedDirectory(isCurrent: () => boolean): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "quarterdeck-pi-prompt-admission-")));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	admissionDisposals.push(installRuntimeWriteAdmission({ canonicalStateHome: root, isCurrent }));
	return await fs.mkdtemp(join(root, "launch-"));
}

describe("Pi prompt delivery", () => {
	it("keeps ordinary prompts inline with the existing outer-whitespace trimming", async () => {
		expect(await preparePiPromptDelivery(" \n hello\n  indented\t world \r\n", { platform: "linux" })).toEqual({
			args: ["hello\n  indented\t world"],
		});
		expect(await preparePiPromptDelivery(" \t\n")).toEqual({ args: [] });
		expect(await preparePiPromptDelivery("x".repeat(PI_INLINE_PROMPT_MAX_BYTES), { platform: "linux" })).toEqual({
			args: ["x".repeat(PI_INLINE_PROMPT_MAX_BYTES)],
		});
	});

	it("counts UTF-8 bytes rather than JavaScript characters at the inline boundary", async () => {
		const inline = "é".repeat(PI_INLINE_PROMPT_MAX_BYTES / 2);
		expect(await preparePiPromptDelivery(inline, { platform: "linux" })).toEqual({ args: [inline] });
		const delivery = await prepareFile(`${inline}é`);
		expect(await fs.readFile(delivery.path, "utf8")).toBe(`\uFEFF${inline}é`);
	});

	it("stores the complete formerly failing 1,991,939-byte prompt without truncation", async () => {
		const prompt = `${"a".repeat(1_991_939 - 20)}\nTask tail preserved`;
		expect(Buffer.byteLength(prompt)).toBe(1_991_939);
		const delivery = await prepareFile(prompt);
		expect(await fs.readFile(delivery.path, "utf8")).toBe(`\uFEFF${prompt}`);
		expect(delivery.args.join("").length).toBeLessThan(1024);
		// The file remains readable after preparation, until the process owner
		// invokes cleanup; concurrent/repeated cleanup is harmless.
		await Promise.all([delivery.cleanup(), delivery.cleanup()]);
		await delivery.cleanup();
		await expect(fs.stat(dirname(delivery.path))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses a private directory and owner-only file on POSIX", async () => {
		const delivery = await prepareFile("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1));
		if (process.platform !== "win32") {
			expect((await fs.stat(dirname(delivery.path))).mode & 0o777).toBe(0o700);
			expect((await fs.stat(delivery.path)).mode & 0o777).toBe(0o600);
		}
	});

	it("does not write content if private-directory preparation fails", async () => {
		const prepare = vi
			.spyOn(promptStorage, "createPiPromptDirectory")
			.mockRejectedValueOnce(new Error("private-path / secret prompt must not escape"));
		const write = vi.spyOn(fs, "writeFile");
		await expect(preparePiPromptDelivery("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1))).rejects.toThrow(
			"Could not prepare a private Pi prompt file. Check Quarterdeck state-home permissions and free space, then retry.",
		);
		expect(prepare).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
	});

	it("preserves typed admission failures from private-directory preparation", async () => {
		const denied = new RuntimeWriteAdmissionError();
		vi.spyOn(promptStorage, "createPiPromptDirectory").mockRejectedValueOnce(denied);
		await expect(preparePiPromptDelivery("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1))).rejects.toBe(denied);
	});

	it("awaits removal of a partially written file when writing fails without exposing its error", async () => {
		const nativeFs = await vi.importActual<typeof fs>("node:fs/promises");
		let writtenPath: string | undefined;
		vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
			writtenPath = String(args[0]);
			await nativeFs.writeFile(...args);
			throw new Error("private-path / secret prompt must not escape");
		});
		await expect(preparePiPromptDelivery("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1))).rejects.toThrow(
			"Could not prepare a private Pi prompt file. Check Quarterdeck state-home permissions and free space, then retry.",
		);
		if (!writtenPath) throw new Error("Expected a partially written prompt file");
		await expect(fs.stat(dirname(writtenPath))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not write or delete content after admission is revoked between directory creation and writing", async () => {
		let current = true;
		const directory = await createAdmittedDirectory(() => current);
		vi.spyOn(promptStorage, "createPiPromptDirectory").mockImplementationOnce(async () => {
			current = false;
			return directory;
		});
		const write = vi.spyOn(fs, "writeFile").mockClear();
		const remove = vi.spyOn(fs, "rm").mockClear();
		await expect(preparePiPromptDelivery("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1))).rejects.toBeInstanceOf(
			RuntimeWriteAdmissionError,
		);
		expect(write).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it("retains private files when cleanup loses admission and permits an admitted retry", async () => {
		let current = true;
		const directory = await createAdmittedDirectory(() => current);
		vi.spyOn(promptStorage, "createPiPromptDirectory").mockResolvedValueOnce(directory);
		const prompt = "x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1);
		const delivery = await prepareFile(prompt);
		current = false;
		const remove = vi.spyOn(fs, "rm").mockClear();
		await expect(delivery.cleanup()).rejects.toBeInstanceOf(RuntimeWriteAdmissionError);
		expect(remove).not.toHaveBeenCalled();
		expect(await fs.readFile(delivery.path, "utf8")).toBe(`\uFEFF${prompt}`);
		current = true;
		await delivery.cleanup();
		await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves the exact typed write-admission failure even when cleanup is also denied", async () => {
		let current = true;
		const directory = await createAdmittedDirectory(() => current);
		vi.spyOn(promptStorage, "createPiPromptDirectory").mockResolvedValueOnce(directory);
		const denied = new RuntimeWriteAdmissionError();
		vi.spyOn(fs, "writeFile").mockImplementationOnce(async () => {
			current = false;
			throw denied;
		});
		const remove = vi.spyOn(fs, "rm").mockClear();
		await expect(preparePiPromptDelivery("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1))).rejects.toBe(denied);
		expect(remove).not.toHaveBeenCalled();
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it("preserves typed cleanup-admission failures instead of masking them as storage errors", async () => {
		let current = true;
		const directory = await createAdmittedDirectory(() => current);
		vi.spyOn(promptStorage, "createPiPromptDirectory").mockResolvedValueOnce(directory);
		vi.spyOn(fs, "writeFile").mockImplementationOnce(async () => {
			current = false;
			throw new Error("private filesystem details");
		});
		await expect(preparePiPromptDelivery("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1))).rejects.toBeInstanceOf(
			RuntimeWriteAdmissionError,
		);
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it("permits retrying cleanup after a content-free cleanup failure", async () => {
		const delivery = await prepareFile("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1));
		vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("private-path / secret"));
		await expect(delivery.cleanup()).rejects.toThrow(
			"Could not remove private Pi prompt storage. Check Quarterdeck state-home access and retry cleanup.",
		);
		await delivery.cleanup();
		await expect(fs.stat(delivery.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses file URLs to preserve special characters and Unicode spaces in temporary paths", async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), "quarterdeck pi # % é \u00a0-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		vi.spyOn(promptStorage, "createPiPromptDirectory").mockImplementationOnce(
			async () => await fs.mkdtemp(join(root, "launch-")),
		);
		const delivery = await prepareFile("x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1));
		expect(dirname(dirname(delivery.path))).toBe(root);
		expect(delivery.args[0]).toContain("%23");
		expect(delivery.args[0]).toContain("%25");
		expect(delivery.args[0]).toContain("%C2%A0");
		expect(await fs.readFile(delivery.path, "utf8")).toBe(`\uFEFF${"x".repeat(PI_INLINE_PROMPT_MAX_BYTES + 1)}`);
	});

	it.each([
		{ name: "leading @", prompt: "@literal-not-a-file" },
		{ name: "embedded NUL", prompt: "embedded\0NUL" },
		{ name: "image magic", prompt: `GIF89a${"x".repeat(PI_INLINE_PROMPT_MAX_BYTES)}` },
	])("keeps special prompt prefixes and content literal ($name)", async ({ prompt }) => {
		const delivery = await prepareFile(prompt);
		// Pi strips this one BOM after image sniffing and does not recursively
		// expand @references, template syntax, or options inside the file.
		expect(await fs.readFile(delivery.path, "utf8")).toBe(`\uFEFF${prompt}`);
	});

	it.each(['say "quoted"', "line\nnext", "line\rnext", "C:\\trailing\\"])(
		"routes Windows quoting hazards through literal file input (%j)",
		async (prompt) => {
			const delivery = await prepareFile(prompt, { platform: "win32" });
			expect(await fs.readFile(delivery.path, "utf8")).toBe(`\uFEFF${prompt}`);
		},
	);

	it("keeps uncomplicated Windows prompts up to 1 KiB inline", async () => {
		const prompt = "x".repeat(PI_WINDOWS_INLINE_PROMPT_MAX_BYTES);
		expect(await preparePiPromptDelivery(prompt, { platform: "win32" })).toEqual({ args: [prompt] });
		await prepareFile(`${prompt}x`, { platform: "win32" });
	});

	it("delivers large slash-prefixed task text literally, not as a native command", async () => {
		const prompt = `/compact ${"x".repeat(PI_INLINE_PROMPT_MAX_BYTES)}`;
		const delivery = await prepareFile(prompt);
		expect(await fs.readFile(delivery.path, "utf8")).toBe(`\uFEFF${prompt}`);
		expect(delivery.args[1]).toBe(PI_FILE_PROMPT_INSTRUCTION);
	});

	it("includes explicit custom positional text only in file delivery and applies the combined cap", async () => {
		expect(await preparePiPromptDelivery("tiny task", { additionalFileText: ["custom"] })).toEqual({
			args: ["tiny task"],
		});
		const create = vi.spyOn(promptStorage, "createPiPromptDirectory").mockClear();
		await expect(
			preparePiPromptDelivery("x".repeat(PI_PROMPT_MAX_BYTES), { additionalFileText: ["custom"] }),
		).rejects.toThrow(
			"Pi task prompt and custom positional text exceed the 8 MiB UTF-8 limit. Shorten the task prompt or custom arguments.",
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("accepts exactly 8 MiB and rejects larger UTF-8 prompts before creating files", async () => {
		const delivery = await prepareFile("x".repeat(PI_PROMPT_MAX_BYTES));
		expect((await fs.stat(delivery.path)).size).toBe(PI_PROMPT_MAX_BYTES + 3);
		const create = vi.spyOn(fs, "mkdtemp").mockClear();
		await expect(preparePiPromptDelivery("é".repeat(PI_PROMPT_MAX_BYTES / 2 + 1))).rejects.toThrow(
			"Pi task prompt exceeds the 8 MiB UTF-8 limit. Shorten the task prompt or split it into smaller tasks.",
		);
		expect(create).not.toHaveBeenCalled();
	});
});
