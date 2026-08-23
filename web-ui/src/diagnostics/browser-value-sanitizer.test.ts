import { describe, expect, it } from "vitest";

import { sanitizeBrowserDiagnosticText, sanitizeBrowserDiagnosticValue } from "@/diagnostics/browser-value-sanitizer";

describe("browser diagnostic sanitization", () => {
	it("redacts content fields, secrets, paths, and URLs before persistence or transport", () => {
		const sanitized = sanitizeBrowserDiagnosticValue({
			prompt: "private task text",
			token: "sk-abcdefghijklmnopqrstuvwxyz",
			message:
				"failed at /Users/person/private/repo/file.ts and https://user:pass@example.test/private?token=secret",
		});
		const serialized = JSON.stringify(sanitized);
		expect(serialized).not.toContain("private task text");
		expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(serialized).not.toContain("/Users/person");
		expect(serialized).not.toContain("example.test");
		expect(serialized).toContain("[REDACTED]");
		expect(serialized).toContain("$PATH");
		expect(serialized).toContain("$URL");
	});

	it("bounds strings and handles cycles", () => {
		const cyclic: Record<string, unknown> = { long: "x".repeat(3_000) };
		cyclic.self = cyclic;
		const sanitized = sanitizeBrowserDiagnosticValue(cyclic) as Record<string, unknown>;
		expect(String(sanitized.long).length).toBeLessThan(2_100);
		expect(sanitized.self).toBe("[CIRCULAR]");
		expect(sanitizeBrowserDiagnosticText("file:///private/data")).toBe("[REDACTED_FILE_URL]");
	});

	it("reduces Error objects to a content-free class", () => {
		expect(sanitizeBrowserDiagnosticValue(new Error("sentinel private browser text"))).toEqual({
			errorClass: "Error",
		});
	});
});
