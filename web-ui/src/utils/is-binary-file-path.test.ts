import { describe, expect, it } from "vitest";
import { isBinaryFilePath } from "@/utils/is-binary-file-path";

describe("isBinaryFilePath", () => {
	it("detects common binary file extensions", () => {
		expect(isBinaryFilePath("assets/logo.png")).toBe(true);
		expect(isBinaryFilePath("archive.tar.gz")).toBe(true);
	});

	it("handles text files and extensionless files", () => {
		expect(isBinaryFilePath("src/app.ts")).toBe(false);
		expect(isBinaryFilePath("Dockerfile")).toBe(false);
	});

	it("handles dotfiles and Windows-style paths", () => {
		expect(isBinaryFilePath(".DS_Store")).toBe(true);
		expect(isBinaryFilePath("C:\\work\\assets\\photo.JPG")).toBe(true);
	});
});
