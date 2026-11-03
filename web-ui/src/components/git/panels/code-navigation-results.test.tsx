import * as Dialog from "@radix-ui/react-dialog";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeNavigationResult } from "@/hooks/git/code-navigation";
import { CodeNavigationResults } from "./code-navigation-results";

vi.mock("@/components/editor/source-editor", () => ({
	SourceEditor: ({ value, readOnly }: { value: string; readOnly: boolean }) => (
		<pre data-read-only={readOnly}>{value}</pre>
	),
}));

const location = {
	path: "src/target.ts",
	range: { start: { line: 8, character: 4 }, end: { line: 8, character: 12 } },
};
const other = { path: "src/other.ts", range: { start: { line: 2, character: 1 }, end: { line: 2, character: 8 } } };
const result: CodeNavigationResult = {
	status: "locations",
	operation: "references",
	sourcePath: "src/original.ts",
	locations: [location, other],
	truncated: false,
};

describe("CodeNavigationResults", () => {
	let container: HTMLDivElement;
	let root: Root;
	let prior: boolean | undefined;
	const onNavigate = vi.fn();
	const onDismiss = vi.fn();
	beforeEach(() => {
		prior = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		onNavigate.mockReset();
		onDismiss.mockReset();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prior;
	});
	const render = async (readFile?: Parameters<typeof CodeNavigationResults>[0]["readFile"]) => {
		await act(async () =>
			root.render(
				<CodeNavigationResults result={result} onDismiss={onDismiss} onNavigate={onNavigate} readFile={readFile} />,
			),
		);
	};
	it("keeps the usages toggle available for busy, empty and unavailable results and never shows it for definition/hover", async () => {
		const onToggle = vi.fn();
		for (const next of [
			{ status: "busy", operation: "references" },
			{ ...result, locations: [] },
			{ status: "unavailable", operation: "references", message: "Upgrade runtime" },
		] satisfies CodeNavigationResult[]) {
			await act(async () =>
				root.render(
					<CodeNavigationResults
						result={next}
						onDismiss={onDismiss}
						onNavigate={onNavigate}
						referencesOptions={{ ignoreComments: false, disabled: false, onToggle }}
					/>,
				),
			);
			const toggle = document.querySelector<HTMLButtonElement>("[aria-pressed]")!;
			expect(toggle.textContent).toBe("Ignore comments");
			expect(toggle.title).toContain("Unknown languages are retained");
			await act(async () => toggle.click());
		}
		expect(onToggle).toHaveBeenCalledTimes(3);
		for (const next of [
			{ ...result, operation: "definition" },
			{ status: "hover", operation: "hover", contents: "type" },
		] satisfies CodeNavigationResult[]) {
			await act(async () =>
				root.render(
					<CodeNavigationResults
						result={next}
						onDismiss={onDismiss}
						onNavigate={onNavigate}
						referencesOptions={{ ignoreComments: true, disabled: false, onToggle }}
					/>,
				),
			);
			expect(document.querySelector("[aria-pressed]")).toBeNull();
		}
	});
	it("preserves popup focus and the selected usage through a filtered rerun", async () => {
		const onToggle = vi.fn();
		async function show(next: CodeNavigationResult, enabled = false) {
			await act(async () =>
				root.render(
					<CodeNavigationResults
						result={next}
						onDismiss={onDismiss}
						onNavigate={onNavigate}
						referencesOptions={{ ignoreComments: enabled, disabled: false, onToggle }}
					/>,
				),
			);
		}
		await show(result);
		await act(async () =>
			document
				.querySelector('[role="listbox"]')!
				.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
		);
		const toggle = document.querySelector<HTMLButtonElement>("[aria-pressed]")!;
		toggle.focus();
		await act(async () => toggle.click());
		await show({ status: "busy", operation: "references" }, true);
		expect(document.activeElement).toBe(toggle);
		await show({ ...result, locations: [other] }, true);
		expect(document.activeElement).toBe(toggle);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("3:2");
		const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
		list.focus();
		await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onNavigate).toHaveBeenCalledWith(other);
	});
	it("disables the filter when the captured source is no longer valid", async () => {
		const onToggle = vi.fn();
		await act(async () =>
			root.render(
				<CodeNavigationResults
					result={result}
					onDismiss={onDismiss}
					onNavigate={onNavigate}
					referencesOptions={{ ignoreComments: false, disabled: true, onToggle }}
				/>,
			),
		);
		const toggle = document.querySelector<HTMLButtonElement>("[aria-pressed]")!;
		expect(toggle.disabled).toBe(true);
		expect(toggle.title).toContain("original source has changed");
		await act(async () => toggle.click());
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("shows grouped counts and opens the complete range", async () => {
		await render();
		expect(document.body.textContent).toContain("Find Usages");
		expect(document.body.textContent).toContain("2 usages in 2 files");
		await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		expect(onNavigate).toHaveBeenCalledWith(location);
		expect(onDismiss.mock.invocationCallOrder[0]).toBeLessThan(onNavigate.mock.invocationCallOrder[0]!);
	});
	it("supports keyboard selection, Enter to open and Escape to close", async () => {
		await render();
		const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
		expect(document.activeElement).toBe(list);
		await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("3:2");
		expect(onNavigate).not.toHaveBeenCalled();
		await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onNavigate).toHaveBeenCalledWith(other);
		await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(onDismiss).toHaveBeenCalledTimes(2);
	});
	describe.each(["definition", "references"] as const)("%s target identity", (operation) => {
		it.each(["line", "character"] as const)(
			"selects and opens a same-start target with a different end %s",
			async (coordinate) => {
				const second = {
					...location,
					range: {
						...location.range,
						end: { ...location.range.end, [coordinate]: location.range.end[coordinate] + 1 },
					},
				};
				await act(async () =>
					root.render(
						<CodeNavigationResults
							result={{ ...result, operation, locations: [location, second] }}
							onDismiss={onDismiss}
							onNavigate={onNavigate}
						/>,
					),
				);
				const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
				await act(async () =>
					list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
				);
				const options = list.querySelectorAll('[role="option"]');
				expect(options[0]!.getAttribute("aria-selected")).toBe("false");
				expect(options[1]!.getAttribute("aria-selected")).toBe("true");
				expect(list.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
				await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
				expect(onNavigate).toHaveBeenCalledExactlyOnceWith(second);
			},
		);
	});

	it("floats in a portal and restores the invoking surface on Escape", async () => {
		function Harness() {
			const [open, setOpen] = useState(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Find usages
					</button>
					{open ? (
						<CodeNavigationResults result={result} onDismiss={() => setOpen(false)} onNavigate={onNavigate} />
					) : null}
				</>
			);
		}
		await act(async () => root.render(<Harness />));
		const invoker = container.querySelector("button")!;
		invoker.focus();
		await act(async () => invoker.click());
		const popup = document.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(popup).not.toBeNull();
		expect(container.contains(popup)).toBe(false);
		expect(popup.className).toContain("fixed");
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(invoker);
	});
	it("focuses dismiss while busy and the list once results arrive", async () => {
		await act(async () =>
			root.render(
				<CodeNavigationResults
					result={{ status: "busy", operation: "references" }}
					referencesOptions={{ ignoreComments: false, disabled: false, onToggle: vi.fn() }}
					onDismiss={onDismiss}
					onNavigate={onNavigate}
				/>,
			),
		);
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Close code navigation results");
		await render();
		expect(document.activeElement?.getAttribute("role")).toBe("listbox");
	});
	it("uses a supplied focus-return owner but leaves destination focus to navigation", async () => {
		const restore = vi.fn();
		function Harness() {
			const [open, setOpen] = useState(true);
			return open ? (
				<CodeNavigationResults
					result={result}
					onDismiss={() => setOpen(false)}
					onNavigate={onNavigate}
					onRestoreFocus={restore}
				/>
			) : null;
		}
		await act(async () => root.render(<Harness />));
		await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(onNavigate).toHaveBeenCalledWith(location);
		expect(restore).not.toHaveBeenCalled();
	});
	it("hands focus to a destination Dialog without restoring over it", async () => {
		function Harness() {
			const [mode, setMode] = useState<"closed" | "results" | "peek">("closed");
			const invoker = useRef<HTMLButtonElement>(null);
			return (
				<>
					<button ref={invoker} type="button" onClick={() => setMode("results")}>
						Find usages
					</button>
					{mode === "results" ? (
						<CodeNavigationResults
							result={result}
							onDismiss={() => setMode("closed")}
							onNavigate={() => setMode("peek")}
							onRestoreFocus={() => invoker.current?.focus()}
						/>
					) : null}
					{mode === "peek" ? (
						<Dialog.Root open onOpenChange={(open) => !open && setMode("closed")}>
							<Dialog.Portal>
								<Dialog.Content
									aria-describedby={undefined}
									onCloseAutoFocus={(event) => {
										event.preventDefault();
										invoker.current?.focus();
									}}
								>
									<Dialog.Title>Source peek</Dialog.Title>
									<button type="button" onClick={() => setMode("closed")}>
										Back to review
									</button>
								</Dialog.Content>
							</Dialog.Portal>
						</Dialog.Root>
					) : null}
				</>
			);
		}
		await act(async () => root.render(<Harness />));
		const invoker = container.querySelector("button")!;
		invoker.focus();
		await act(async () => invoker.click());
		await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(document.querySelector('[aria-label="Code navigation results"]')).toBeNull();
		expect(document.activeElement?.textContent).toBe("Back to review");
		await act(async () =>
			document.activeElement!.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			),
		);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(invoker);
	});
	it("does not dismiss for composing/prevented Escape or leak Escape to the global handler", async () => {
		await render();
		const globalEscape = vi.fn();
		window.addEventListener("keydown", globalEscape);
		try {
			const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
			await act(async () =>
				list.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }),
				),
			);
			const prevented = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			prevented.preventDefault();
			await act(async () => list.dispatchEvent(prevented));
			expect(onDismiss).not.toHaveBeenCalled();
			await act(async () =>
				list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
			);
			expect(onDismiss).toHaveBeenCalledOnce();
			expect(globalEscape).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener("keydown", globalEscape);
		}
	});
	it("ignores composing and already-handled list keystrokes", async () => {
		await render();
		const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
		const handled = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
		handled.preventDefault();
		await act(async () => list.dispatchEvent(handled));
		await act(async () =>
			list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })),
		);
		expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("9:5");
		expect(onNavigate).not.toHaveBeenCalled();
	});
	it("clamps Home/End and arrow navigation without opening a target", async () => {
		await render();
		const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
		for (const key of ["End", "ArrowDown"]) {
			await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
		}
		expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("3:2");
		for (const key of ["Home", "ArrowUp"]) {
			await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
		}
		expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("9:5");
		expect(onNavigate).not.toHaveBeenCalled();
	});
	it("previews only the selected file and ignores a late previous preview", async () => {
		let finish!: (value: null) => void;
		const readFile = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<null>((resolve) => {
						finish = resolve;
					}),
			)
			.mockResolvedValue({ content: "const current = 1;", binary: false, truncated: false });
		await render(readFile);
		expect(readFile).toHaveBeenCalledExactlyOnceWith(location.path);
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next usage"]')!.click());
		expect(readFile).toHaveBeenLastCalledWith(other.path);
		expect(document.querySelector('[data-read-only="true"]')?.textContent).toBe("const current = 1;");
		await act(async () => finish(null));
		expect(document.querySelector('[data-read-only="true"]')?.textContent).toBe("const current = 1;");
	});
});
