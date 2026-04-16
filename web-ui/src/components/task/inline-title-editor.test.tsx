import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlineTitleEditor } from "@/components/task/inline-title-editor";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("InlineTitleEditor", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderEditor(props: { onRegenerate?: (taskId: string) => void; isLlmGenerationDisabled?: boolean }): void {
		act(() => {
			root.render(
				<TooltipProvider>
					<InlineTitleEditor
						cardId="task-1"
						currentTitle="Test title"
						onSave={vi.fn()}
						onClose={vi.fn()}
						stopEvent={vi.fn()}
						{...props}
					/>
				</TooltipProvider>,
			);
		});
	}

	it("uses Sparkles icon for the regenerate button", () => {
		renderEditor({ onRegenerate: vi.fn() });
		const button = container.querySelector("button[aria-label='Auto-generate title']");
		expect(button).not.toBeNull();
		// Sparkles icon renders as an SVG — verify it's present
		const svg = button?.querySelector("svg");
		expect(svg).not.toBeNull();
	});

	it("does not render the regenerate button when onRegenerate is not provided", () => {
		renderEditor({});
		const button = container.querySelector("button[aria-label='Auto-generate title']");
		expect(button).toBeNull();
	});

	it("renders the regenerate button as enabled when isLlmGenerationDisabled is false", () => {
		renderEditor({ onRegenerate: vi.fn(), isLlmGenerationDisabled: false });
		const button = container.querySelector("button[aria-label='Auto-generate title']") as HTMLButtonElement;
		expect(button).not.toBeNull();
		expect(button.disabled).toBe(false);
	});

	it("renders the regenerate button as disabled when isLlmGenerationDisabled is true", () => {
		renderEditor({ onRegenerate: vi.fn(), isLlmGenerationDisabled: true });
		const button = container.querySelector("button[aria-label='Auto-generate title']") as HTMLButtonElement;
		expect(button).not.toBeNull();
		expect(button.disabled).toBe(true);
	});

	it("does not fire onRegenerate when button is disabled and clicked", () => {
		const onRegenerate = vi.fn();
		renderEditor({ onRegenerate, isLlmGenerationDisabled: true });
		const button = container.querySelector("button[aria-label='Auto-generate title']") as HTMLButtonElement;
		act(() => {
			button.click();
		});
		expect(onRegenerate).not.toHaveBeenCalled();
	});
});
