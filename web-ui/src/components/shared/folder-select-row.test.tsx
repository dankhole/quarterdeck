import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSelectFolderRow } from "@/hooks/search/folder-select";
import { FolderSelectRowButton } from "./folder-select-row";

const row: FolderSelectFolderRow = {
	kind: "folder",
	key: "feature-folder",
	label: "feature",
	depth: 2,
	expanded: false,
	count: 3,
};

describe("FolderSelectRowButton", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("renders one named native button, forwards its ref/props and exposes expansion, count and depth", async () => {
		const ref = createRef<HTMLButtonElement>();
		const onToggle = vi.fn();
		const onMouseEnter = vi.fn();
		const onClick = vi.fn();
		await act(async () =>
			root.render(
				<FolderSelectRowButton
					row={row}
					onToggle={onToggle}
					ref={ref}
					className="active-row"
					data-row="folder"
					onClick={onClick}
					onMouseEnter={onMouseEnter}
				/>,
			),
		);
		const button = container.querySelector("button")!;
		expect(container.querySelectorAll("button")).toHaveLength(1);
		expect(ref.current).toBe(button);
		expect(button.type).toBe("button");
		expect(button.getAttribute("aria-label")).toBe("feature, 3 items");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.classList.contains("active-row")).toBe(true);
		expect(button.dataset.row).toBe("folder");
		expect(button.style.paddingInlineStart).toBe("40px");
		expect(button.textContent).toBe("feature3");
		await act(async () => {
			button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			button.click();
		});
		expect(onMouseEnter).toHaveBeenCalledOnce();
		expect(onClick).toHaveBeenCalledOnce();
		expect(onToggle).toHaveBeenCalledOnce();
		button.focus();
		expect(document.activeElement).toBe(button);
		await act(async () =>
			root.render(<FolderSelectRowButton row={{ ...row, expanded: true }} onToggle={onToggle} />),
		);
		expect(button.getAttribute("aria-expanded")).toBe("true");
	});

	it("announces a single descendant item with singular wording", async () => {
		await act(async () => root.render(<FolderSelectRowButton row={{ ...row, count: 1 }} onToggle={vi.fn()} />));
		expect(container.querySelector("button")!.getAttribute("aria-label")).toBe("feature, 1 item");
	});

	it("keeps native disabled behavior and lets a caller prevent the toggle", async () => {
		const onToggle = vi.fn();
		await act(async () => root.render(<FolderSelectRowButton row={row} onToggle={onToggle} disabled />));
		await act(async () => container.querySelector("button")!.click());
		expect(onToggle).not.toHaveBeenCalled();
		await act(async () =>
			root.render(
				<FolderSelectRowButton
					row={row}
					onToggle={onToggle}
					aria-label="Custom name"
					onClick={(event) => event.preventDefault()}
				/>,
			),
		);
		const button = container.querySelector("button")!;
		expect(button.getAttribute("aria-label")).toBe("Custom name");
		await act(async () => button.click());
		expect(onToggle).not.toHaveBeenCalled();
	});
});
