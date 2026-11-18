import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./app-error-boundary";

vi.mock("@/runtime/runtime-connection-state", () => ({ isRuntimeDisconnected: () => false }));

describe("desktop renderer recovery", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		container = document.createElement("div");
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("retries rendering without exposing a direct reload that bypasses native draft protection", () => {
		let failing = true;
		function Content() {
			if (failing) throw new Error("Synthetic renderer failure");
			return <p>Recovered renderer</p>;
		}
		act(() =>
			root.render(
				<AppErrorBoundary>
					<Content />
				</AppErrorBoundary>,
			),
		);
		expect(container.textContent).toContain("native Reload Window or Quit action");
		const buttons = container.querySelectorAll("button");
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.textContent).toBe("Try again");
		failing = false;
		act(() => buttons[0]?.click());
		expect(container.textContent).toBe("Recovered renderer");
	});
});
