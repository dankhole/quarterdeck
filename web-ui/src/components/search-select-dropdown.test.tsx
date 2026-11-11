import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchSelectDropdown, type SearchSelectOption } from "@/components/search-select-dropdown";
import { TooltipProvider } from "@/components/ui/tooltip";

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const getOptionPath = (option: SearchSelectOption) => option.value.split("/");
const options = ["main", "feature/a", "feature/nested/b", "release/a"].map((value) => ({ value, label: value }));

function menu(): HTMLElement {
	const element = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper] > [role="dialog"]');
	if (!element) throw new Error("Expected the picker menu");
	return element;
}
function input(): HTMLInputElement {
	const element = menu().querySelector("input");
	if (!element) throw new Error("Expected search input");
	return element;
}
function folder(label: string): HTMLButtonElement {
	const element = Array.from(menu().querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find(
		(button) => button.querySelector("span")?.textContent === label,
	);
	if (!element) throw new Error(`Expected folder ${label}`);
	return element;
}
function rowLabels(): Array<string | null> {
	return Array.from(menu().querySelectorAll("button")).map((button) =>
		button.hasAttribute("aria-expanded") ? (button.querySelector("span")?.textContent ?? null) : button.textContent,
	);
}
async function key(key: string): Promise<void> {
	await act(async () => {
		input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
}
async function search(value: string): Promise<void> {
	await act(async () => {
		const field = input();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("SearchSelectDropdown folder rows", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let scrollDescriptor: PropertyDescriptor | undefined;
	const onSelect = vi.fn();

	beforeEach(() => {
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		onSelect.mockClear();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
		else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	async function render(props: Partial<ComponentProps<typeof SearchSelectDropdown>> = {}): Promise<void> {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<SearchSelectDropdown options={options} onSelect={onSelect} pinSelectedToTop={false} {...props} />
				</TooltipProvider>,
			),
		);
	}
	async function open(): Promise<void> {
		await act(async () => container.querySelector("button")?.click());
		await act(async () => input().focus());
	}

	it("initially activates the selected branch instead of its folder, including after closing a collapsed selection", async () => {
		const selectedValue = "feature/nested/b";
		await render({ getOptionPath, selectedValue });
		await open();
		expect(menu().querySelector("button.bg-surface-3")?.textContent).toBe("b");
		await key("Enter");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(selectedValue);
		onSelect.mockClear();
		await open();
		await act(async () => folder("feature").click());
		await key("Escape");
		await open();
		expect(folder("feature").getAttribute("aria-expanded")).toBe("true");
		expect(menu().querySelector("button.bg-surface-3")?.textContent).toBe("b");
		await key("Enter");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(selectedValue);
	});

	it("keeps real input focus after a mouse folder toggle so subsequent keys reach the search handler", async () => {
		await render({ getOptionPath });
		await open();
		const feature = folder("feature");
		const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		await act(async () => {
			// jsdom has no native mouse-focus default; reproduce it unless the handler cancels it.
			if (feature.dispatchEvent(mouseDown)) feature.focus();
			feature.click();
		});
		expect(mouseDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(input());
		await act(async () => {
			document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		await act(async () => {
			document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("feature/a");
	});

	it("does not scroll the active row again for same-row hover, folder expansion, or unrelated renders", async () => {
		await render({ getOptionPath });
		await open();
		const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView);
		scrollIntoView.mockClear();
		await act(async () => {
			menu()
				.querySelector("button")
				?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		});
		expect(scrollIntoView).not.toHaveBeenCalled();
		await render({ getOptionPath, buttonText: "Updated trigger" });
		expect(scrollIntoView).not.toHaveBeenCalled();
		await key("ArrowDown");
		scrollIntoView.mockClear();
		await key("Enter");
		expect(folder("feature").getAttribute("aria-expanded")).toBe("true");
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it("keeps the original flat order and recommended-model sections when grouping is absent", async () => {
		await render({ recommendedOptionValues: ["feature/nested/b"] });
		await open();
		expect(rowLabels()).toEqual(["feature/nested/b", "main", "feature/a", "release/a"]);
		expect(menu().textContent).toContain("Recommended models");
		expect(menu().textContent).toContain("All models");
		expect(menu().querySelector("[aria-expanded]")).toBeNull();
		await key("ArrowDown");
		await key("Enter");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("main");
	});

	it("traverses only visible folder and branch rows, with Enter toggling folders without closing or losing search focus", async () => {
		await render({ getOptionPath });
		await open();
		expect(rowLabels()).toEqual(["main", "feature", "release"]);
		await key("ArrowDown");
		await key("Enter");
		expect(folder("feature").getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(input());
		expect(onSelect).not.toHaveBeenCalled();
		expect(rowLabels()).toEqual(["main", "feature", "a", "nested", "release"]);
		await key("ArrowDown");
		await key("ArrowDown");
		await key("Enter");
		expect(rowLabels()).toEqual(["main", "feature", "a", "nested", "b", "release"]);
		await key("End");
		await key("ArrowUp");
		await key("Enter");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("feature/nested/b");
		expect(document.querySelector("[data-radix-popper-content-wrapper]")).toBeNull();
	});

	it("matches full original names through collapsed folders and restores expansion when search clears", async () => {
		await render({ getOptionPath });
		await open();
		await act(async () => folder("release").click());
		await search("feature/nested/b");
		expect(rowLabels()).toEqual(["feature/nested/b"]);
		expect(menu().querySelector("[aria-expanded]")).toBeNull();
		expect(menu().querySelector('span[style*="font-weight"]')).not.toBeNull();
		await search("");
		expect(folder("release").getAttribute("aria-expanded")).toBe("true");
		expect(folder("feature").getAttribute("aria-expanded")).toBe("false");
		await search("feature/nested/b");
		await key("Enter");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("feature/nested/b");
	});

	it("opens selected ancestors, preserves display suffixes, allows collapse, and resets folders on close", async () => {
		const selectedValue = "feature/nested/b";
		await render({
			getOptionPath,
			selectedValue,
			options: options.map((option) => ({
				...option,
				label: option.value === selectedValue ? `${option.value} (current)` : option.label,
			})),
		});
		await open();
		expect(rowLabels()).toEqual(["main", "feature", "a", "nested", "b (current)", "release"]);
		await act(async () => folder("feature").click());
		expect(rowLabels()).toEqual(["main", "feature", "release"]);
		await search("feature/nested/b");
		expect(rowLabels()).toEqual(["feature/nested/b (current)"]);
		await search("(current)");
		expect(rowLabels()).toEqual(["feature/nested/b (current)"]);
		await search("");
		expect(folder("feature").getAttribute("aria-expanded")).toBe("false");
		await act(async () => folder("release").click());
		await key("Escape");
		await open();
		expect(folder("feature").getAttribute("aria-expanded")).toBe("true");
		expect(folder("nested").getAttribute("aria-expanded")).toBe("true");
		expect(folder("release").getAttribute("aria-expanded")).toBe("false");
	});

	it("never selects a formerly active hidden branch after collapse or list replacement", async () => {
		await render({ getOptionPath, selectedValue: "feature/nested/b" });
		await open();
		await key("End");
		await key("ArrowUp"); // b
		await act(async () => folder("feature").click());
		await key("Enter"); // feature, not its now-hidden b
		expect(onSelect).not.toHaveBeenCalled();
		expect(folder("feature").getAttribute("aria-expanded")).toBe("true");
		await key("End");
		await render({ getOptionPath, options: [{ value: "main", label: "main" }] });
		await key("Enter");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("main");
	});

	it("handles no results and Home/End after filtering, and disables grouping live", async () => {
		await render({ getOptionPath });
		await open();
		await search("no-matching-branch");
		expect(menu().textContent).toContain("No matching results");
		await key("Enter");
		expect(onSelect).not.toHaveBeenCalled();
		await key("Escape");
		await open();
		await render();
		expect(rowLabels()).toEqual(options.map((option) => option.label));
		await key("End");
		await key("Home");
		await key("Enter");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("main");
	});
});
