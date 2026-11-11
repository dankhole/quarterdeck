import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSelectFolderRow } from "./folder-select";
import {
	type UseFolderSelectRowsOptions,
	type UseFolderSelectRowsResult,
	useFolderSelectRows,
} from "./use-folder-select-rows";

const items = ["main", "feature/a", "feature/nested/b", "release/c"];
const getKey = (item: string) => item;
const getPath = (item: string) => item.split("/");

describe("useFolderSelectRows", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: UseFolderSelectRowsResult<string>;
	let props: UseFolderSelectRowsOptions<string>;

	function Harness(options: UseFolderSelectRowsOptions<string>) {
		current = useFolderSelectRows(options);
		return null;
	}
	async function render(changes: Partial<UseFolderSelectRowsOptions<string>> = {}) {
		props = { ...props, ...changes };
		await act(async () =>
			root.render(
				<StrictMode>
					<Harness {...props} />
				</StrictMode>,
			),
		);
	}
	function folder(label: string): FolderSelectFolderRow {
		const row = current.rows.find((row) => row.kind === "folder" && row.label === label);
		if (row?.kind !== "folder") throw new Error(`Missing folder ${label}`);
		return row;
	}
	async function toggle(label: string) {
		await act(async () => current.toggleFolder(folder(label).key));
	}
	const labels = () => current.rows.map((row) => row.label);

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		props = { items, getKey, getPath, selectedKey: "feature/nested/b", isSearching: false };
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("initially opens selected ancestors, allows collapse, and resets for picker close", async () => {
		await render();
		expect(labels()).toEqual(["main", "feature", "a", "nested", "b", "release"]);
		const reset = current.resetFolders;
		await toggle("feature");
		await toggle("release");
		expect(labels()).toEqual(["main", "feature", "release", "c"]);
		await act(async () => current.resetFolders());
		expect(labels()).toEqual(["main", "feature", "a", "nested", "b", "release"]);
		expect(current.resetFolders).toBe(reset);
	});

	it("shows flat canonical search results and restores explicit choices after clearing", async () => {
		await render();
		await toggle("feature");
		await toggle("release");
		const expandedRows = current.rows;
		await render({ items: ["feature/nested/b", "release/c"], isSearching: true });
		expect(labels()).toEqual(["feature/nested/b", "release/c"]);
		expect(current.rows.every((row) => row.kind === "item" && row.depth === 0)).toBe(true);
		await render({ items: [], isSearching: true });
		expect(current.rows).toEqual([]);
		await render({ items, isSearching: false });
		expect(current.rows).toEqual(expandedRows);
	});

	it("resets a changed selection to its own ancestors without reopening explicitly collapsed ancestors on refetch", async () => {
		await render();
		await toggle("feature");
		await render({ items: [...items] });
		expect(folder("feature").expanded).toBe(false);
		await render({ selectedKey: "release/c" });
		expect(folder("feature").expanded).toBe(false);
		expect(folder("release").expanded).toBe(true);
		expect(labels()).toEqual(["main", "feature", "release", "c"]);
		await toggle("release");
		await render({ items: [...items, "release/d"] });
		expect(folder("release")).toMatchObject({ count: 2, expanded: false });
	});

	it("expands selected ancestors when asynchronous refs arrive, and drops removed visible descendants", async () => {
		await render({ items: [] });
		expect(current.rows).toEqual([]);
		await render({ items });
		expect(labels()).toContain("b");
		await render({ items: ["main", "release/c"] });
		expect(labels()).toEqual(["main", "release"]);
		await render({ items });
		expect(labels()).toContain("b");
	});

	it("handles grouping switches without losing choices, and reset while searching restores initial ancestors", async () => {
		await render({ getPath: undefined });
		expect(labels()).toEqual(items);
		await render({ getPath });
		expect(folder("feature").expanded).toBe(true);
		await toggle("feature");
		await render({ getPath: undefined });
		await render({ getPath });
		expect(folder("feature").expanded).toBe(false);
		await render({ items: ["release/c"], isSearching: true });
		await act(async () => current.resetFolders());
		await render({ items, isSearching: false });
		expect(folder("feature").expanded).toBe(true);
		expect(folder("nested").expanded).toBe(true);
		expect(folder("release").expanded).toBe(false);
	});

	it("reuses rows across parent renders and rebuilds only the visible projection on expansion", async () => {
		const path = vi.fn(getPath);
		const key = vi.fn(getKey);
		await render({ getPath: path, getKey: key });
		const originalRows = current.rows;
		const originalToggle = current.toggleFolder;
		const pathCalls = path.mock.calls.length;
		const keyCalls = key.mock.calls.length;
		await render();
		expect(current.rows).toBe(originalRows);
		expect(current.toggleFolder).toBe(originalToggle);
		expect(path).toHaveBeenCalledTimes(pathCalls);
		expect(key).toHaveBeenCalledTimes(keyCalls);
		await act(async () => current.resetFolders());
		expect(current.rows).toBe(originalRows);
		await toggle("feature");
		expect(current.rows).not.toBe(originalRows);
		expect(path).toHaveBeenCalledTimes(pathCalls);
		expect(key).toHaveBeenCalledTimes(keyCalls);
		const collapsedRows = current.rows;
		await render();
		expect(current.rows).toBe(collapsedRows);
		expect(folder("feature").expanded).toBe(false);
	});

	it("reuses flat rows across parent renders in search and disabled modes", async () => {
		await render({ isSearching: true });
		const searchRows = current.rows;
		await render();
		expect(current.rows).toBe(searchRows);
		await render({ getPath: undefined, isSearching: false });
		expect(current.rows).toBe(searchRows);
		await render();
		expect(current.rows).toBe(searchRows);
	});

	it("invalidates presentation when key or path callback semantics change", async () => {
		await render();
		const originalRows = current.rows;
		await render({ getPath: (item) => [item] });
		expect(current.rows).not.toBe(originalRows);
		expect(labels()).toEqual(items);
		const previousKeys = current.rows.map((row) => row.key);
		await render({ getKey: (item) => `ref:${item}` });
		expect(current.rows.map((row) => row.key)).not.toEqual(previousKeys);
		const changedRows = current.rows;
		await render();
		expect(current.rows).toBe(changedRows);
	});

	it("ignores unknown and hidden folder toggles, and composes repeated functional updates", async () => {
		await render();
		const featureKey = folder("feature").key;
		await act(async () => {
			current.toggleFolder(featureKey);
			current.toggleFolder(featureKey);
			current.toggleFolder("not-a-folder");
		});
		expect(folder("feature").expanded).toBe(true);
		const nestedKey = folder("nested").key;
		await toggle("feature");
		await act(async () => current.toggleFolder(nestedKey));
		await toggle("feature");
		expect(folder("nested").expanded).toBe(true);
	});
});
