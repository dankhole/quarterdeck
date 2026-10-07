import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockedFileSystem } from "../../../src/fs/locked-file-system";
import {
	assertRuntimeWriteAdmission,
	installRuntimeWriteAdmission,
	RuntimeWriteAdmissionError,
	waitForRuntimeWriteQuiescence,
	withRuntimeWriteOperation,
} from "../../../src/state/runtime-write-admission";
import { createTempDir } from "../../utilities/temp-dir";

const writeHook = vi.hoisted(() => ({ afterWrite: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			await actual.writeFile(...args);
			writeHook.afterWrite?.();
		},
	};
});

const disposals: Array<() => void> = [];
afterEach(() => {
	writeHook.afterWrite = undefined;
	for (const dispose of disposals.splice(0).reverse()) dispose();
});

function fixture(isCurrent: () => boolean) {
	const temp = createTempDir("quarterdeck-write-admission-");
	const home = join(temp.path, "state");
	disposals.push(temp.cleanup);
	const dispose = installRuntimeWriteAdmission({ canonicalStateHome: home, isCurrent });
	disposals.push(dispose);
	return { temp: temp.path, home, dispose };
}

describe("runtime write admission", () => {
	it("leaves factories unfenced and protects only the matching home", () => {
		expect(() => assertRuntimeWriteAdmission("/unadmitted/state/board.json")).not.toThrow();
		const { home } = fixture(() => false);
		expect(() => assertRuntimeWriteAdmission(join(home, "projects", "p", "board.json"))).toThrow(
			RuntimeWriteAdmissionError,
		);
		expect(() => assertRuntimeWriteAdmission(home)).toThrow(RuntimeWriteAdmissionError);
		expect(() => assertRuntimeWriteAdmission(`${home}-other/projects/p/board.json`)).not.toThrow();
		expect(() => assertRuntimeWriteAdmission(join(home, "..", "other", "board.json"))).not.toThrow();
	});

	it("allows independent diagnostics, ownership evidence and append-only hook ingress", () => {
		const { home } = fixture(() => false);
		for (const store of ["diagnostics", "hook-transition-outbox", "runtime-ownership", "managed-processes"]) {
			expect(() => assertRuntimeWriteAdmission(join(home, store, "generation", "record.json"))).not.toThrow();
		}
		expect(() => assertRuntimeWriteAdmission(join(home, "projects", "diagnostics", "board.json"))).toThrow();
	});

	it("denies unverifiable callback failures with a typed error", () => {
		const { home } = fixture(() => {
			throw new Error("lease unreadable");
		});
		expect(() => assertRuntimeWriteAdmission(join(home, "config.json"))).toThrow(RuntimeWriteAdmissionError);
	});

	it("denies initial writes before creating their directories", async () => {
		const { home } = fixture(() => false);
		const path = join(home, "projects", "p", "board.json");
		await expect(new LockedFileSystem().writeTextFileAtomic(path, "new")).rejects.toThrow(RuntimeWriteAdmissionError);
		expect(existsSync(home)).toBe(false);
	});

	it("keeps the last committed model when ownership is lost after writing the temporary file", async () => {
		let current = true;
		const { home } = fixture(() => current);
		const path = join(home, "board.json");
		await new LockedFileSystem().writeTextFileAtomic(path, "old", { lock: null });
		writeHook.afterWrite = () => {
			current = false;
		};
		await expect(new LockedFileSystem().writeTextFileAtomic(path, "new", { lock: null })).rejects.toThrow(
			RuntimeWriteAdmissionError,
		);
		expect(readFileSync(path, "utf8")).toBe("old");
	});

	it("also fences external backup commits by their source owner", async () => {
		let current = true;
		const { home, temp } = fixture(() => current);
		const path = join(temp, "backup.json");
		writeFileSync(path, "old");
		writeHook.afterWrite = () => {
			current = false;
		};
		await expect(
			new LockedFileSystem().writeTextFileAtomic(path, "new", { lock: null, admissionPaths: [home] }),
		).rejects.toThrow(RuntimeWriteAdmissionError);
		expect(readFileSync(path, "utf8")).toBe("old");
	});

	it("holds the write drain through failures and prevents disposal while work remains", async () => {
		const { home, dispose } = fixture(() => true);
		let release = () => {};
		const blocker = new Promise<void>((resolve) => {
			release = resolve;
		});
		const operation = withRuntimeWriteOperation([join(home, "board.json")], async () => {
			await blocker;
			throw new Error("write failed");
		});
		const rejection = expect(operation).rejects.toThrow("write failed");
		expect(dispose).toThrow("not quiesced");
		let drained = false;
		const drain = waitForRuntimeWriteQuiescence(home).then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		release();
		await rejection;
		await drain;
		expect(drained).toBe(true);
		dispose();
	});
});
