import { describe, expect, it } from "vitest";

import { buildFileTree } from "./file-tree";

describe("buildFileTree", () => {
	it("deduplicates normalized paths and promotes parent files to directories", () => {
		const tree = buildFileTree(["src", "/src//app.ts/", "src/app.ts", "src/lib/index.ts", "", "/"]);

		expect(tree).toEqual([
			{
				name: "src",
				path: "src",
				type: "directory",
				children: [
					{
						name: "lib",
						path: "src/lib",
						type: "directory",
						children: [{ name: "index.ts", path: "src/lib/index.ts", type: "file", children: [] }],
					},
					{ name: "app.ts", path: "src/app.ts", type: "file", children: [] },
				],
			},
		]);
	});

	it("keeps identical names in different parents and treats special object keys as ordinary names", () => {
		const tree = buildFileTree(["right/__proto__", "left/__proto__", "constructor", "toString"]);

		expect(tree.map((node) => node.path)).toEqual(["left", "right", "constructor", "toString"]);
		expect(tree[0]?.children.map((node) => node.path)).toEqual(["left/__proto__"]);
		expect(tree[1]?.children.map((node) => node.path)).toEqual(["right/__proto__"]);
	});

	it("builds a wide repository tree with every sibling sorted and isolated", () => {
		const paths = Array.from({ length: 5_000 }, (_, index) => `wide/file-${String(index).padStart(6, "0")}.ts`);
		const tree = buildFileTree([...paths].reverse(), ["wide/empty", "wide", "wide/empty"]);

		expect(tree).toHaveLength(1);
		expect(tree[0]?.children.map((node) => node.path)).toEqual(["wide/empty", ...paths]);
		expect(tree[0]?.children.every((node) => node.children.length === 0)).toBe(true);
	});

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
