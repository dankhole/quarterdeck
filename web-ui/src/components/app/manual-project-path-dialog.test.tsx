import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualProjectPathDialog } from "@/components/app/manual-project-path-dialog";

vi.mock("@/components/ui/dialog", () => ({
	Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
	DialogHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
	DialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
	DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("ManualProjectPathDialog", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("submits a normalized runtime-local path through Quarterdeck UI", () => {
		const onConfirm = vi.fn();
		act(() => {
			root.render(<ManualProjectPathDialog open isAdding={false} onCancel={vi.fn()} onConfirm={onConfirm} />);
		});

		const input = container.querySelector("input");
		const form = container.querySelector("form");
		if (!input || !form) {
			throw new Error("Expected manual path form controls.");
		}

		act(() => {
			const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			valueSetter?.call(input, "  /srv/projects/quarterdeck  ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});

		expect(onConfirm).toHaveBeenCalledWith("/srv/projects/quarterdeck");
	});
});
