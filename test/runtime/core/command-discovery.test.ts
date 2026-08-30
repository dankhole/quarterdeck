import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isBinaryAvailableOnPath, resolveWindowsBinaryPath } from "../../../src/core";

describe("Windows command discovery", () => {
	it("uses the defined PATH alias and normalizes quoted entries and PATHEXT", () => {
		const directory = mkdtempSync(join(tmpdir(), "quarterdeck command discovery "));
		try {
			writeFileSync(join(directory, "codex.cmd"), "");

			expect(
				isBinaryAvailableOnPath("codex", {
					platform: "win32",
					env: {
						PATH: undefined,
						Path: `"${directory}"`,
						Pathext: " EXE ; CMD ",
					},
				}),
			).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("returns the exact inherited-PATH target used for a Windows launch", () => {
		const directory = mkdtempSync(join(tmpdir(), "quarterdeck command discovery "));
		try {
			const executablePath = join(directory, "codex.exe");
			writeFileSync(executablePath, "");

			expect(resolveWindowsBinaryPath("codex", { PATH: directory, PATHEXT: ".exe;.cmd" })).toEqual({
				extension: ".exe",
				path: executablePath,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves leading whitespace in Windows PATH entries", () => {
		const root = mkdtempSync(join(tmpdir(), "quarterdeck-command-discovery-root-"));
		const directory = join(root, " leading-bin");
		try {
			mkdirSync(directory);
			writeFileSync(join(directory, "codex.cmd"), "");

			expect(
				isBinaryAvailableOnPath("codex", {
					platform: "win32",
					env: { PATH: directory, PATHEXT: ".CMD" },
				}),
			).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not report extensionless files that Windows command launch cannot resolve", () => {
		const directory = mkdtempSync(join(tmpdir(), "quarterdeck command discovery "));
		try {
			const extensionlessPath = join(directory, "codex");
			writeFileSync(extensionlessPath, "");

			expect(
				isBinaryAvailableOnPath("codex", {
					platform: "win32",
					env: { PATH: directory, PATHEXT: ".EXE;.CMD" },
				}),
			).toBe(false);
			expect(
				isBinaryAvailableOnPath(extensionlessPath, {
					platform: "win32",
					env: { PATHEXT: ".EXE;.CMD" },
				}),
			).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reports PowerShell shims that the Windows launcher can execute without a PATHEXT entry", () => {
		const directory = mkdtempSync(join(tmpdir(), "quarterdeck command discovery "));
		try {
			const shimPath = join(directory, "codex.ps1");
			writeFileSync(shimPath, "");

			expect(
				isBinaryAvailableOnPath("codex.ps1", {
					platform: "win32",
					env: { PATH: directory, PATHEXT: ".EXE;.CMD" },
				}),
			).toBe(true);
			expect(
				isBinaryAvailableOnPath(shimPath, {
					platform: "win32",
					env: { PATHEXT: ".EXE;.CMD" },
				}),
			).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reports an explicit command shim even when PATHEXT omits command files", () => {
		const directory = mkdtempSync(join(tmpdir(), "quarterdeck command discovery "));
		try {
			const shimPath = join(directory, "codex.cmd");
			writeFileSync(shimPath, "");

			expect(
				isBinaryAvailableOnPath(shimPath, {
					platform: "win32",
					env: { PATHEXT: ".EXE" },
				}),
			).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
