import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredDiffRows } from "./deferred-diff-rows";

describe("DeferredDiffRows", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	const observers: Array<{
		callback: IntersectionObserverCallback;
		options?: IntersectionObserverInit;
		target?: Element;
		disconnect: () => void;
	}> = [];

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		observers.length = 0;
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				entry: (typeof observers)[number];
				constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
					this.entry = { callback, options, disconnect: vi.fn() };
					observers.push(this.entry);
				}
				observe(target: Element) {
					this.entry.target = target;
				}
				disconnect() {
					this.entry.disconnect();
				}
			},
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("renders small groups immediately without observers", async () => {
		await act(async () =>
			root.render(
				<DeferredDiffRows rows={[1, 2]} getRowKey={String} renderRow={(row) => <span key={row}>{row}</span>} />,
			),
		);
		expect(container.textContent).toBe("12");
		expect(observers).toHaveLength(0);
	});

	it("renders only intersecting chunks and keeps their contents available afterwards", async () => {
		container.dataset.diffScrollContainer = "";
		const rows = Array.from({ length: 1000 }, (_, index) => index);
		const renderRow = vi.fn((row: number) => <span key={row}>{row}</span>);
		await act(async () => root.render(<DeferredDiffRows rows={rows} getRowKey={String} renderRow={renderRow} />));
		expect(renderRow).not.toHaveBeenCalled();
		expect(observers.length).toBeLessThan(20);
		const observer = observers[0]!;
		expect(observer.options).toEqual({ root: container, rootMargin: "600px 0px" });
		await act(async () =>
			observer.callback(
				[{ isIntersecting: true, target: observer.target } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			),
		);
		expect(container.querySelectorAll("span")).toHaveLength(80);
		expect(renderRow).toHaveBeenCalledTimes(80);
		expect(observer.disconnect).toHaveBeenCalled();
		await act(async () =>
			observer.callback(
				[{ isIntersecting: false, target: observer.target } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			),
		);
		expect(container.querySelectorAll("span")).toHaveLength(80);
		await act(async () => {
			for (const nextObserver of observers.slice(1)) {
				nextObserver.callback(
					[{ isIntersecting: true, target: nextObserver.target } as IntersectionObserverEntry],
					{} as IntersectionObserver,
				);
			}
		});
		expect(Array.from(container.querySelectorAll("span"), (element) => element.textContent)).toEqual(
			rows.map(String),
		);
	});

	it("renders all rows when observer support is unavailable", async () => {
		vi.stubGlobal("IntersectionObserver", undefined);
		const rows = Array.from({ length: 250 }, (_, index) => index);
		await act(async () =>
			root.render(
				<DeferredDiffRows rows={rows} getRowKey={String} renderRow={(row) => <span key={row}>{row}</span>} />,
			),
		);
		expect(container.querySelectorAll("span")).toHaveLength(250);
	});

	it("keeps immediate row parents when the same group grows past the deferral threshold", async () => {
		const render = async (length: number) => {
			const rows = Array.from({ length }, (_, index) => index);
			await act(async () =>
				root.render(
					<DeferredDiffRows rows={rows} getRowKey={String} renderRow={(row) => <span key={row}>{row}</span>} />,
				),
			);
		};
		await render(200);
		const row = container.querySelectorAll("span")[160]!;
		const parent = row.parentElement;
		await render(240);
		expect(container.querySelectorAll("span")[160]).toBe(row);
		expect(row.parentElement).toBe(parent);
		expect(observers).toHaveLength(0);
		await render(200);
		expect(container.querySelectorAll("span")[160]).toBe(row);
		expect(row.parentElement).toBe(parent);
	});
});
