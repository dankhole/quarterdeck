import { describe, expect, it } from "vitest";

import { toFileUrl } from "@/utils/file-url";

describe("toFileUrl", () => {
	it("converts Unix absolute paths to file urls", () => {
		expect(toFileUrl("/Users/dev/repo/.quarterdeck/config.json")).toBe(
			"file:///Users/dev/repo/.quarterdeck/config.json",
		);
	});

	it("converts Windows absolute paths to file urls", () => {
		expect(toFileUrl("C:\\Users\\dev\\quarterdeck config.json")).toBe(
			"file:///C:/Users/dev/quarterdeck%20config.json",
		);
	});

	it("returns normalized file url input", () => {
		expect(toFileUrl("file:///C:/Users/dev/config.json")).toBe("file:///C:/Users/dev/config.json");
	});

	it("converts UNC paths to file urls", () => {
		expect(toFileUrl("\\\\server\\share\\folder\\file.txt")).toBe("file://server/share/folder/file.txt");
	});
});
