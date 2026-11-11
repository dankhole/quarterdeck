import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShellTerminalPanel } from "@/components/terminal/shell-terminal-panel";
import { TooltipProvider } from "@/components/ui/tooltip";

const controls = vi.hoisted(() => ({
	clearTerminal: vi.fn(),
	containerRef: { current: null },
	isLoading: false,
	isContentPending: false,
	isStopping: false,
	lastError: null,
	stopTerminal: vi.fn(async () => {}),
}));

vi.mock("@/terminal/use-persistent-terminal-session", () => ({
	usePersistentTerminalSession: () => controls,
}));

describe("ShellTerminalPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("exposes independent hide, terminate and restart actions without calling the viewer stop API", async () => {
		const onClose = vi.fn();
		const onTerminate = vi.fn();
		const onRestart = vi.fn();
		await act(async () => {
			root.render(
				<TooltipProvider>
					<ShellTerminalPanel
						taskId="__home_terminal__"
						projectId="project-1"
						summary={null}
						onClose={onClose}
						onTerminate={onTerminate}
						onRestart={onRestart}
					/>
				</TooltipProvider>,
			);
		});
		const actions = [
			["Hide shell", onClose],
			["Terminate shell", onTerminate],
			["Restart terminal", onRestart],
		] as const;
		for (const [label, callback] of actions) {
			const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
			expect(button).toBeInstanceOf(HTMLButtonElement);
			await act(async () => button?.click());
			expect(callback).toHaveBeenCalledTimes(1);
		}
		expect(container.querySelector('[aria-label="Close terminal"]')).toBeNull();
		expect(controls.stopTerminal).not.toHaveBeenCalled();
	});
});
