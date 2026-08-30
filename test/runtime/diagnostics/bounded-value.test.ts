import { describe, expect, it } from "vitest";

import { normalizeDiagnosticErrorClass } from "../../../src/core";
import { getDiagnosticErrorClass, sanitizeDiagnosticText, sanitizeDiagnosticValue } from "../../../src/diagnostics";

describe("diagnostic value sanitization", () => {
	it("reduces thrown values to stable content-free error classes", () => {
		const error = Object.assign(new Error("private task text"), { code: "EACCES" });
		expect(getDiagnosticErrorClass(error)).toBe("EACCES");
		expect(getDiagnosticErrorClass(new Error("private task text"))).toBe("Error");
		expect(getDiagnosticErrorClass("private task text")).toBe("UnknownError");
		expect(normalizeDiagnosticErrorClass("TypeError")).toBe("TypeError");
		expect(normalizeDiagnosticErrorClass("sentinel private text")).toBe("UnknownError");
		expect(sanitizeDiagnosticValue(new Error("sentinel private text")).value).toEqual({ errorClass: "Error" });
	});

	it("redacts secrets, content-bearing fields, URLs, and unknown paths", () => {
		const result = sanitizeDiagnosticValue({
			authorization: "Bearer very-secret-token-value",
			prompt: "private task text",
			endpointUrl: "https://user:password@example.test/private?q=secret",
			workingDirectory: "/private/unknown/project",
			message: "token sk-abcdefghijklmnopqrstuvwxyz at https://example.test/private",
		});

		expect(result.value).toMatchObject({
			authorization: "[REDACTED:sensitive]",
			prompt: "[REDACTED:content]",
			endpointUrl: "https://$HOST/$PATH",
			workingDirectory: "$PATH",
		});
		expect(JSON.stringify(result.value)).not.toContain("private task text");
		expect(JSON.stringify(result.value)).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(result.truncation?.redacted).toBeGreaterThanOrEqual(5);
	});

	it("replaces multiple known paths with stable aliases", () => {
		const result = sanitizeDiagnosticText(
			"state=/private/lab/state project=/private/lab/state/projects/p1 worktree=/private/lab/worktrees/t1",
			{
				pathAliases: {
					stateHome: "/private/lab/state",
					projects: new Map([["p1", "/private/lab/state/projects/p1"]]),
					worktrees: new Map([["t1", "/private/lab/worktrees/t1"]]),
				},
			},
		);
		expect(result.value).toContain("state=$STATE");
		expect(result.value).toContain("project=$PROJECT:p1");
		expect(result.value).toContain("worktree=$WORKTREE:t1");
		expect(result.value).not.toContain("/private/lab");
	});

	it("redacts unknown Windows drive, UNC, and namespace paths after separator normalization", () => {
		const result = sanitizeDiagnosticText(
			"root=C:\\secret.txt drive=C:\\Users\\Alice\\Secret\\file.txt unc=\\\\server\\share\\private\\file.txt namespace=\\\\?\\C:\\Users\\Alice\\Hidden\\file.txt",
		);

		expect(result.value).toBe("root=$PATH drive=$PATH unc=$PATH namespace=$PATH");
		expect(result.truncation?.redacted).toBe(2);
	});

	it("redacts complete unquoted Windows paths containing spaces", () => {
		const result = sanitizeDiagnosticText(
			"drive=C:\\Users\\Alice Smith\\Secret File.txt unc=\\\\server\\private share\\Secret File.txt next=ok",
		);

		expect(result.value).toBe("drive=$PATH unc=$PATH next=ok");
		expect(result.value).not.toContain("Alice Smith");
		expect(result.value).not.toContain("private share");
	});

	it("matches Windows aliases case-insensitively across namespace forms", () => {
		const result = sanitizeDiagnosticText("source=\\\\?\\c:\\USERS\\ALICE\\repo\\src\\file.ts", {
			pathAliases: {
				projects: new Map([["p1", "C:\\Users\\Alice\\Repo"]]),
			},
		});

		expect(result.value).toBe("source=$PROJECT:p1/src/file.ts");
		expect(result.value).not.toContain("ALICE");
	});

	it("does not apply a Windows alias to a sibling path prefix", () => {
		const result = sanitizeDiagnosticText(
			"sibling=C:\\Users\\Alice\\Repository\\file.txt device=\\\\.\\C:\\private.txt:stream",
			{
				pathAliases: {
					projects: new Map([["p1", "C:\\Users\\Alice\\Repo"]]),
				},
			},
		);

		expect(result.value).toBe("sibling=$PATH device=$PATH");
		expect(result.value).not.toContain("$PROJECT:p1sitory");
	});

	it("bounds strings, arrays, objects, depth, getters, and circular values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const withGetter = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(withGetter, "broken", {
			enumerable: true,
			get: () => {
				throw new Error("do not evaluate me");
			},
		});
		const result = sanitizeDiagnosticValue(
			{
				long: "x".repeat(40),
				array: [1, 2, 3, 4],
				object: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11 },
				deep: { a: { b: { c: true } } },
				circular,
				withGetter,
			},
			{ limits: { maxStringLength: 10, maxArrayEntries: 2, maxObjectKeys: 10, maxDepth: 2 } },
		);
		expect(result.truncation).toMatchObject({ arrays: 1, objects: 1 });
		expect(result.truncation?.strings).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(result.value)).not.toContain("do not evaluate me");
	});

	it("normalizes values that JSON cannot represent directly", () => {
		const result = sanitizeDiagnosticValue({
			big: 123n,
			nan: Number.NaN,
			binary: Buffer.from("private"),
			map: new Map([["key", "value"]]),
		});
		expect(result.value).toMatchObject({
			big: "[BigInt:123]",
			nan: "[NaN]",
			binary: "[Binary:7 bytes]",
		});
	});
});
