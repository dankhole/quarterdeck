// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	buildFolderSelectTree,
	flattenFolderSelectTree,
	folderSelectFolderKey,
	getFolderSelectRows,
} from "./folder-select";

const getKey = (name: string) => name;
const getPath = (name: string) => name.split("/");
const options = (items: readonly string[], selectedKey?: string) => ({
	items,
	getKey,
	getPath,
	selectedKey,
	isSearching: false,
});

function expandAll(items: readonly string[]) {
	const tree = buildFolderSelectTree(options(items));
	const expansion = new Map<string, boolean>();
	for (const item of items) {
		const path = getPath(item);
		for (let depth = 1; depth < path.length; depth++) {
			expansion.set(folderSelectFolderKey(path.slice(0, depth)), true);
		}
	}
	return flattenFolderSelectTree(tree, expansion);
}

describe("folder select presentation", () => {
	it("preserves first-occurrence sibling order, depth and descendant branch counts", () => {
		const rows = expandAll(["main", "feature/z", "release/a", "feature/nested/b", "feature/a", "tail"]);
		expect(rows.map(({ kind, label, depth }) => [kind, label, depth])).toEqual([
			["item", "main", 0],
			["folder", "feature", 0],
			["item", "z", 1],
			["folder", "nested", 1],
			["item", "b", 2],
			["item", "a", 1],
			["folder", "release", 0],
			["item", "a", 1],
			["item", "tail", 0],
		]);
		expect(rows.filter((row) => row.kind === "folder").map((row) => row.count)).toEqual([3, 1, 1]);
	});

	it("opens only selected ancestors and permits explicitly collapsing them", () => {
		const opts = options(["feature/a", "feature/nested/b", "release/a"], "feature/nested/b");
		expect(getFolderSelectRows(opts).map((row) => row.label)).toEqual(["feature", "a", "nested", "b", "release"]);
		const rows = getFolderSelectRows(opts, new Map([[folderSelectFolderKey(["feature"]), false]]));
		expect(rows.map((row) => row.label)).toEqual(["feature", "release"]);
		expect(rows[0]).toMatchObject({ expanded: false, count: 2 });
	});

	it("keeps similar prefixes, case, duplicate basenames and remote namespaces distinct", () => {
		const items = ["feature/a", "features/a", "Feature/a", "origin/feature/a", "upstream/feature/a", "origin/main"];
		const rows = expandAll(items);
		expect(rows.filter((row) => row.kind === "folder").map((row) => [row.label, row.count])).toEqual([
			["feature", 1],
			["features", 1],
			["Feature", 1],
			["origin", 2],
			["feature", 1],
			["upstream", 1],
			["feature", 1],
		]);
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
		expect(rows.filter((row) => row.kind === "item").map((row) => row.item)).toEqual([
			"feature/a",
			"features/a",
			"Feature/a",
			"origin/feature/a",
			"origin/main",
			"upstream/feature/a",
		]);
	});

	it("encodes path boundaries and tags collision-safely, even for arbitrary generic segments", () => {
		const items = [
			{ key: "folder", path: ["a/b", "same"] },
			{ key: "a/b", path: ["a", "b", "same"] },
			{ key: '["folder","a"]', path: ["a", "same"] },
			{ key: "quoted", path: ['a"', "same"] },
			{ key: "empty", path: ["", "same"] },
		];
		const tree = buildFolderSelectTree({ items, getKey: (item) => item.key, getPath: (item) => item.path });
		const expansion = new Map([
			[folderSelectFolderKey(["a/b"]), true],
			[folderSelectFolderKey(["a"]), true],
			[folderSelectFolderKey(["a", "b"]), true],
			[folderSelectFolderKey(['a"']), true],
			[folderSelectFolderKey([""]), true],
		]);
		const rows = flattenFolderSelectTree(tree, expansion);
		expect(rows.filter((row) => row.kind === "item")).toHaveLength(items.length);
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
	});

	it("retains item references and fields, and handles root leaves and empty paths", () => {
		const items = [
			{ id: "canonical", path: ["group", "display"], suffix: "current" },
			{ id: "root", path: [], suffix: "extra" },
		];
		const rows = getFolderSelectRows({
			items,
			getKey: (item) => item.id,
			getPath: (item) => item.path,
			selectedKey: "canonical",
			isSearching: false,
		});
		expect(rows[1]).toMatchObject({ label: "display", depth: 1, item: items[0] });
		expect(rows[1]?.kind === "item" && rows[1].item).toBe(items[0]);
		expect(rows[2]).toMatchObject({ label: "root", depth: 0, item: items[1] });
	});

	it("bypasses all folders for search and disabled grouping without reordering", () => {
		const items = ["feature/z", "main", "feature/a", "origin/nested/b"];
		const searching = getFolderSelectRows({ ...options(items), isSearching: true });
		const disabled = getFolderSelectRows({ ...options(items), getPath: undefined });
		for (const rows of [searching, disabled]) {
			expect(rows.map((row) => row.label)).toEqual(items);
			expect(rows.every((row) => row.kind === "item" && row.depth === 0)).toBe(true);
		}
		expect(searching.map((row) => row.key)).toEqual(disabled.map((row) => row.key));
	});

	it("returns empty rows and does not invent absent selected items", () => {
		expect(getFolderSelectRows(options([], "missing/a"))).toEqual([]);
		expect(getFolderSelectRows(options(["feature/a"], "missing/a"))).toEqual([
			expect.objectContaining({ kind: "folder", expanded: false, count: 1 }),
		]);
	});
});
