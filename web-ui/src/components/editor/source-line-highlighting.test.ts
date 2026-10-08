// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createSourceLineCache } from "./source-line-highlighting";

describe("editor highlighting in review rows", () => {
	it("escapes source text while using editor token classes", () => {
		const html = createSourceLineCache("file.ts").get('const value = "<script>";');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain('class="');
	});
	it("retains unsupported editor languages and skips very long lines", () => {
		expect(createSourceLineCache("file.sh").get("echo hello")).toContain("token");
		expect(createSourceLineCache("file.ts").get("x".repeat(20_001))).toBeNull();
	});
});
