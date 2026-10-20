import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitActionErrorDialog } from "./git-action-error-dialog";

describe("Git action error dialog", () => {
	let root: Root;
	let container: HTMLDivElement;
	const onClose = vi.fn();
	const onStashAndRetry = vi.fn();
	const stderr = "remote: Enumerating objects: 500, done.\nReceiving objects: 100%\nfatal: unable to update local ref";

	function render(props: Partial<ComponentProps<typeof GitActionErrorDialog>> = {}): void {
		act(() => {
			root.render(
				<GitActionErrorDialog
					open
					title="Fetch failed"
					message={stderr}
					output={stderr}
					onClose={onClose}
					{...props}
				/>,
			);
		});
	}

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		onClose.mockReset();
		onStashAndRetry.mockReset();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("announces the concise failure and initially collapses the full command output", () => {
		render();
		const dialog = document.querySelector('[role="alertdialog"]')!;
		expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Fetch failed");
		const description = document.getElementById(dialog.getAttribute("aria-describedby")!);
		expect(description?.textContent).toBe("fatal: unable to update local ref");
		const details = document.querySelector("details")!;
		expect(details.open).toBe(false);
		expect(details.querySelector("summary")?.textContent).toBe("Show details");
		expect(details.querySelector("pre")?.textContent).toBe(stderr);
		expect(document.querySelectorAll("pre")).toHaveLength(1);
		act(() => details.querySelector("summary")!.click());
		expect(details.open).toBe(true);
		const output = details.querySelector("pre")!;
		expect(output.getAttribute("aria-label")).toBe("Git command output");
		output.focus();
		expect(document.activeElement).toBe(output);
	});

	it("preserves error-only text and closes normally", () => {
		render({ message: "No remote is configured.", output: null });
		expect(document.querySelector("pre")?.textContent).toBe("No remote is configured.");
		act(() => [...document.querySelectorAll("button")].find((button) => button.textContent === "Close")!.click());
		expect(onClose).toHaveBeenCalled();
	});

	it("keeps a long token complete in the details and bounds its announced summary", () => {
		const message = `fatal: ${"x".repeat(10_000)}`;
		render({ message, output: message });
		const dialog = document.querySelector('[role="alertdialog"]')!;
		expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent?.length).toBe(360);
		expect(document.querySelector("pre")?.textContent).toBe(message);
	});

	it("collapses details again when a different failure arrives", () => {
		render();
		act(() => document.querySelector("summary")!.click());
		expect(document.querySelector("details")?.open).toBe(true);
		render({ message: "fatal: different failure", output: null });
		expect(document.querySelector("details")?.open).toBe(false);
	});

	it("preserves stash and retry behavior and disables actions while it runs", () => {
		render({ title: "Pull failed", onStashAndRetry });
		const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Stash & Pull")!;
		act(() => retry.click());
		expect(onStashAndRetry).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
		render({ title: "Pull failed", onStashAndRetry, isStashAndRetrying: true });
		expect([...document.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
	});
});
