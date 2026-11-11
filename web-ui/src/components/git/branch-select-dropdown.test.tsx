import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRANCH_DROPDOWN_CLASS_NAME } from "@/components/git/branch-dropdown-presentation";
import { BranchSelectDropdown } from "@/components/git/branch-select-dropdown";
import { TooltipProvider } from "@/components/ui/tooltip";

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const LONG_BRANCH = "feature/SDP-53843-osb-independent-markets-with-a-very-long-branch-name";

async function hover(element: Element): Promise<void> {
	await act(async () => {
		const event = new MouseEvent("pointermove", { bubbles: true });
		Object.defineProperty(event, "pointerType", { value: "mouse" });
		element.dispatchEvent(event);
		await new Promise((resolve) => setTimeout(resolve, 180));
	});
}

describe("BranchSelectDropdown", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	it("groups inside the supplied portal, preserves suffixes and tooltips, and pins/selects canonical names", async () => {
		const onSelect = vi.fn();
		const onSetDefault = vi.fn();
		const portal = document.createElement("div");
		container.appendChild(portal);
		await act(async () =>
			root.render(
				<TooltipProvider>
					<BranchSelectDropdown
						groupBranchesByFolder
						options={[{ value: LONG_BRANCH, label: `${LONG_BRANCH} (current)` }]}
						selectedValue={LONG_BRANCH}
						onSelect={onSelect}
						onSetDefault={onSetDefault}
						portalContainer={portal}
					/>
				</TooltipProvider>,
			),
		);
		// React owns container children, so attach the dialog-local portal after render.
		container.appendChild(portal);
		await act(async () => container.querySelector("button")?.click());
		const menu = portal.querySelector('[role="dialog"]');
		expect(menu).not.toBeNull();
		expect(menu?.querySelector('button[aria-expanded][aria-label^="feature"]')?.getAttribute("aria-expanded")).toBe(
			"true",
		);
		const leaf = menu?.querySelector<HTMLButtonElement>("button.group\\/option");
		expect(leaf?.textContent).toBe(`${LONG_BRANCH.split("/").at(-1)} (current)`);
		await hover(leaf!.querySelector("span")!);
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(LONG_BRANCH);
		await act(async () => leaf?.querySelector("button")?.click());
		expect(onSetDefault).toHaveBeenCalledExactlyOnceWith(LONG_BRANCH);
		expect(onSelect).not.toHaveBeenCalled();
		expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
		await act(async () => leaf?.click());
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(LONG_BRANCH);
		portal.remove();
	});

	it("uses a wide viewport-capped menu and exposes complete names on hover without changing selection", async () => {
		const onSelect = vi.fn();
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BranchSelectDropdown
						options={[
							{ value: "main", label: "main" },
							{ value: LONG_BRANCH, label: LONG_BRANCH },
						]}
						selectedValue={LONG_BRANCH}
						onSelect={onSelect}
					/>
				</TooltipProvider>,
			);
		});
		const triggerLabel = container.querySelector("button span.truncate");
		expect(triggerLabel).not.toBeNull();
		await hover(triggerLabel!);
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(LONG_BRANCH);

		await act(async () => container.querySelector("button")?.click());
		const menu = document.querySelector('[data-radix-popper-content-wrapper] > [role="dialog"]');
		expect(menu).not.toBeNull();
		for (const className of BRANCH_DROPDOWN_CLASS_NAME.split(" ")) {
			expect(menu?.classList.contains(className)).toBe(true);
		}
		expect((menu as HTMLElement).style.width).toBe("");
		const option = Array.from(menu!.querySelectorAll("button")).find((button) => button.textContent === LONG_BRANCH);
		expect(option).toBeDefined();
		await hover(option!.querySelector("span")!);
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(LONG_BRANCH);
		expect(onSelect).not.toHaveBeenCalled();
		await act(async () => option!.click());
		expect(onSelect).toHaveBeenCalledWith(LONG_BRANCH);
	});
});
