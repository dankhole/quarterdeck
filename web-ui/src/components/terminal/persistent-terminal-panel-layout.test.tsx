import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	PersistentTerminalPanelLayout,
	type PersistentTerminalSessionControls,
} from "@/components/terminal/persistent-terminal-panel-layout";
import { TooltipProvider } from "@/components/ui/tooltip";

function createSessionControls(
	overrides: Partial<PersistentTerminalSessionControls> = {},
): PersistentTerminalSessionControls {
	return {
		clearTerminal: vi.fn(),
		containerRef: { current: null },
		isLoading: false,
		isStopping: false,
		lastError: null,
		requestRestore: vi.fn(),
		stopTerminal: vi.fn(async () => {}),
		...overrides,
	};
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

describe("PersistentTerminalPanelLayout", () => {
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

	it("exposes terminal re-sync in the full session toolbar", async () => {
		const requestRestore = vi.fn();
		const sessionControls = createSessionControls({ requestRestore });

		await act(async () => {
			root.render(
				<TooltipProvider>
					<PersistentTerminalPanelLayout taskId="task-1" summary={null} sessionControls={sessionControls} />
				</TooltipProvider>,
			);
		});

		const resyncButton = findButtonByText(container, "Re-sync");
		expect(resyncButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			resyncButton?.click();
		});

		expect(requestRestore).toHaveBeenCalledTimes(1);
	});

	it("exposes terminal re-sync in the compact shell terminal header", async () => {
		const requestRestore = vi.fn();
		const sessionControls = createSessionControls({ requestRestore });

		await act(async () => {
			root.render(
				<TooltipProvider>
					<PersistentTerminalPanelLayout
						taskId="task-1"
						summary={null}
						sessionControls={sessionControls}
						showSessionToolbar={false}
						onClose={() => {}}
					/>
				</TooltipProvider>,
			);
		});

		const resyncButton = container.querySelector<HTMLButtonElement>('[aria-label="Re-sync terminal content"]');
		expect(resyncButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			resyncButton?.click();
		});

		expect(requestRestore).toHaveBeenCalledTimes(1);
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Close terminal"]')).toBeInstanceOf(
			HTMLButtonElement,
		);
	});

	it("keeps the compact header hidden when no close control is provided", async () => {
		const sessionControls = createSessionControls();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<PersistentTerminalPanelLayout
						taskId="task-1"
						summary={null}
						sessionControls={sessionControls}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector<HTMLButtonElement>('[aria-label="Re-sync terminal content"]')).toBeNull();
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Clear terminal"]')).toBeNull();
	});
});
