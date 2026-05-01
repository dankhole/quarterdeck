import { describe, expect, it } from "vitest";

import { buildFileTree } from "./file-tree";

describe("buildFileTree", () => {
	it("includes empty directories from directory paths", () => {
		const tree = buildFileTree(["src/app.ts"], ["empty", "src/components"]);

		expect(tree).toEqual([
			{
				name: "empty",
				path: "empty",
				type: "directory",
				children: [],
			},
			{
				name: "src",
				path: "src",
				type: "directory",
				children: [
					{
						name: "components",
						path: "src/components",
						type: "directory",
						children: [],
					},
					{
						name: "app.ts",
						path: "src/app.ts",
						type: "file",
						children: [],
					},
				],
			},
		]);
	});
});
