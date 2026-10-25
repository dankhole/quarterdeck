import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeWorkdirFileChange } from "@/runtime/types";
import { FileTreePanel } from "./file-tree-panel";

const files: RuntimeWorkdirFileChange[] = ["src/nested/app.ts", "src/other.ts", "README.md"].map((path) => ({
	path,
	status: "modified",
	additions: 2,
	deletions: 1,
	oldText: null,
	newText: null,
}));

describe("FileTreePanel folder expansion", () => {
	let container: HTMLDivElement;
	let root: Root;
	const onSelectPath = vi.fn();

	beforeEach(() => {
		onSelectPath.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	async function render(projectFiles = files) {
		await act(async () => {
			root.render(
				<FileTreePanel projectFiles={projectFiles} selectedPath="src/nested/app.ts" onSelectPath={onSelectPath} />,
			);
		});
	}

	function button(name: string) {
		const result = Array.from(container.querySelectorAll("button")).find(
			(element) => element.querySelector(".truncate")?.textContent === name,
		);
		if (!result) throw new Error(`Missing button: ${name}`);
		return result;
	}

	async function click(name: string) {
		await act(async () => button(name).click());
	}

	it("starts expanded and toggles folder contents without selecting a file", async () => {
		await render();
		expect(button("src").getAttribute("aria-expanded")).toBe("true");
		expect(button("app.ts").classList.contains("kb-file-tree-row-selected")).toBe(true);
		await click("src");
		expect(button("src").getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("app.ts");
		expect(container.textContent).not.toContain("other.ts");
		expect(button("README.md")).toBeDefined();
		expect(onSelectPath).not.toHaveBeenCalled();
		await click("src");
		expect(button("src").getAttribute("aria-expanded")).toBe("true");
		expect(button("app.ts").classList.contains("kb-file-tree-row-selected")).toBe(true);
		await click("app.ts");
		expect(onSelectPath).toHaveBeenCalledWith("src/nested/app.ts");
		expect(button("app.ts").hasAttribute("aria-expanded")).toBe(false);
	});

	it("preserves nested collapse choices when a parent reopens and files refresh", async () => {
		await render();
		await click("nested");
		expect(button("nested").getAttribute("aria-expanded")).toBe("false");
		expect(button("other.ts")).toBeDefined();
		await click("src");
		await render([...files]);
		expect(button("src").getAttribute("aria-expanded")).toBe("false");
		await click("src");
		expect(button("nested").getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("app.ts");
		await click("nested");
		expect(button("app.ts")).toBeDefined();
	});
});
