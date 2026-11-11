import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRANCH_DROPDOWN_CLASS_NAME } from "@/components/git/branch-dropdown-presentation";
import { BranchPillTrigger, BranchSelectorPopover } from "@/components/git/panels/branch-selector-popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeGitRef } from "@/runtime/types";

function createDetachedRef(): RuntimeGitRef {
	return {
		name: "deadbee",
		type: "detached",
		hash: "deadbeef12345678",
		isHead: true,
	};
}

function createRef(name: string, type: RuntimeGitRef["type"] = "branch"): RuntimeGitRef {
	return { name, type, hash: "abc123", isHead: false };
}

function findFolder(name: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find((button) =>
		button.getAttribute("aria-label")?.startsWith(`${name}, `),
	);
}

function findBranch(name: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
		(button) => button.textContent?.trim() === name,
	);
}

function setInputValue(input: HTMLInputElement, value: string): void {
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("BranchSelectorPopover", () => {
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

	async function renderPicker(props: Partial<ComponentProps<typeof BranchSelectorPopover>> = {}): Promise<void> {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BranchSelectorPopover
						isOpen
						onOpenChange={() => {}}
						branches={[
							createRef("feature/pinned"),
							createRef("feature/nested/current"),
							createRef("feature/other"),
							createRef("release/next"),
							createRef("main"),
							createRef("origin/feature/remote", "remote"),
							createRef("upstream/feature/remote", "remote"),
						]}
						currentBranch="feature/nested/current"
						pinnedBranches={["feature/pinned"]}
						worktreeBranches={new Map()}
						onSelectBranchView={() => {}}
						groupBranchesByFolder
						trigger={<BranchPillTrigger label="feature/nested/current" />}
						{...props}
					/>
				</TooltipProvider>,
			);
		});
	}

	it("groups only Local/Remote, expands selected ancestors, and keeps remote namespaces distinct", async () => {
		const onSelect = vi.fn();
		await renderPicker({ disableContextMenu: true, onSelectBranchView: onSelect });
		expect(findBranch("feature/pinned")).toBeDefined();
		expect(findBranch("main")).toBeDefined();
		expect(findFolder("feature")?.getAttribute("aria-expanded")).toBe("true");
		expect(findFolder("feature")?.textContent).toBe("feature2");
		expect(findFolder("nested")?.getAttribute("aria-expanded")).toBe("true");
		expect(findBranch("current")).toBeDefined();
		expect(findBranch("next")).toBeUndefined();
		expect(findFolder("origin")?.getAttribute("aria-expanded")).toBe("false");
		expect(findFolder("upstream")?.getAttribute("aria-expanded")).toBe("false");
		await act(async () => findFolder("origin")?.click());
		const remoteFeature = Array.from(
			document.querySelectorAll<HTMLButtonElement>('button[aria-label^="feature, "]'),
		)[1];
		await act(async () => remoteFeature?.click());
		expect(findBranch("remote")).toBeDefined();
		expect(onSelect).not.toHaveBeenCalled();
		await act(async () => findBranch("remote")?.click());
		expect(onSelect).toHaveBeenCalledWith("origin/feature/remote");
	});

	it("searches full names flat, restores expansion after clearing, and resets on close", async () => {
		await renderPicker({ disableContextMenu: true });
		await act(async () => findFolder("feature")?.click());
		await act(async () => findFolder("release")?.click());
		expect(findBranch("current")).toBeUndefined();
		expect(findBranch("next")).toBeDefined();
		const input = document.querySelector<HTMLInputElement>('input[name="branch-selector-filter"]')!;
		await act(async () => setInputValue(input, "feature/remote"));
		expect(findBranch("feature/remote")).toBeDefined();
		expect(findBranch("upstream/feature/remote")).toBeDefined();
		expect(document.querySelector('[role="dialog"] button[aria-expanded]')).toBeNull();
		await act(async () => setInputValue(input, "nonexistent-branch"));
		expect(document.body.textContent).toContain("No matching branches");
		await act(async () => setInputValue(input, ""));
		expect(findFolder("feature")?.getAttribute("aria-expanded")).toBe("false");
		expect(findFolder("release")?.getAttribute("aria-expanded")).toBe("true");
		await renderPicker({ isOpen: false });
		await renderPicker();
		expect(findBranch("current")).toBeDefined();
		expect(findFolder("release")?.getAttribute("aria-expanded")).toBe("false");
	});

	it("preserves search display when toggling grouping while retaining canonical tooltips and selection", async () => {
		const onSelect = vi.fn();
		const props = { disableContextMenu: true, onSelectBranchView: onSelect };
		await renderPicker({ ...props, groupBranchesByFolder: false });
		const input = document.querySelector<HTMLInputElement>('input[name="branch-selector-filter"]')!;
		await act(async () => setInputValue(input, "feature/remote"));
		for (const grouped of [false, true, false]) {
			await renderPicker({ ...props, groupBranchesByFolder: grouped });
			expect(findBranch("feature/remote")).toBeDefined();
			expect(findBranch("upstream/feature/remote")).toBeDefined();
			expect(findBranch("origin/feature/remote")).toBeUndefined();
			expect(document.querySelector('[role="dialog"] button[aria-expanded]')).toBeNull();
		}
		await renderPicker({ ...props, groupBranchesByFolder: true });
		const branch = findBranch("feature/remote");
		await act(async () => {
			branch
				?.querySelector("span")
				?.dispatchEvent(Object.assign(new MouseEvent("pointermove", { bubbles: true }), { pointerType: "mouse" }));
			await new Promise((resolve) => setTimeout(resolve, 180));
		});
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("origin/feature/remote");
		await act(async () => branch?.click());
		expect(onSelect).toHaveBeenCalledWith("origin/feature/remote");
	});

	it.each([
		["Browse files", "onSelectBranchView"],
		["Checkout", "onCheckoutBranch"],
		["Compare with local tree", "onCompareWithBranch"],
		["Merge into current", "onMergeBranch"],
		["Create branch from here", "onCreateBranch"],
		["Delete branch", "onDeleteBranch"],
		["Rebase onto", "onRebaseBranch"],
		["Rename branch", "onRenameBranch"],
		["Reset to here", "onResetToRef"],
		["Pull from remote", "onPull"],
		["Push to remote", "onPush"],
		["Pin to top", "onTogglePinBranch"],
	] as const)("keeps canonical identity for grouped %s actions", async (label, callback) => {
		const action = vi.fn();
		await renderPicker({ [callback]: action });
		await act(async () => findBranch("other")?.click());
		const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
			(element) => element.textContent?.trim() === label,
		);
		expect(item).toBeDefined();
		await act(async () => item?.click());
		expect(action).toHaveBeenCalledWith("feature/other");
	});

	it("preserves grouped worktree locks", async () => {
		const onCheckout = vi.fn();
		await renderPicker({
			onCheckoutBranch: onCheckout,
			onRenameBranch: vi.fn(),
			onDeleteBranch: vi.fn(),
			worktreeBranches: new Map([["feature/other", "Other task"]]),
		});
		const locked = findBranch("otherin use");
		expect(locked).toBeDefined();
		expect(locked?.querySelector('[role="button"]')).toBeNull();
		await act(async () => locked?.click());
		for (const label of ["Checkout", "Rename branch", "Delete branch"]) {
			const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
				(element) => element.textContent?.trim() === label,
			);
			expect(item?.getAttribute("aria-disabled")).toBe("true");
		}
		expect(onCheckout).not.toHaveBeenCalled();
	});

	it("keeps inline checkout separate from grouped branch selection", async () => {
		const onCheckout = vi.fn();
		const onSelect = vi.fn();
		await renderPicker({ onCheckoutBranch: onCheckout, onSelectBranchView: onSelect });
		const checkout = findBranch("other")?.querySelector<HTMLElement>('[role="button"]');
		expect(checkout).not.toBeNull();
		await act(async () => checkout?.click());
		expect(onCheckout).toHaveBeenCalledWith("feature/other");
		expect(onSelect).not.toHaveBeenCalled();
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});

	it("shows full canonical tooltips for grouped leaves", async () => {
		await renderPicker();
		const label = findBranch("current")?.querySelector("span");
		expect(label).toBeDefined();
		await act(async () => {
			label?.dispatchEvent(
				Object.assign(new MouseEvent("pointermove", { bubbles: true }), { pointerType: "mouse" }),
			);
			await new Promise((resolve) => setTimeout(resolve, 180));
		});
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("feature/nested/current");
	});

	it.each([false, true])(
		"shows full canonical names for pinned, local and remote branches (pure picker: %s)",
		async (disableContextMenu) => {
			const names = ["feature/pinned-long-name", "release/local-long-name", "origin/main"];
			await act(async () => {
				root.render(
					<TooltipProvider>
						<BranchSelectorPopover
							isOpen
							onOpenChange={() => {}}
							branches={names.map((name, index) => ({
								name,
								type: index === 2 ? "remote" : "branch",
								hash: "abc123",
								isHead: index === 0,
							}))}
							currentBranch={names[0]!}
							pinnedBranches={[names[0]!]}
							worktreeBranches={new Map()}
							onSelectBranchView={() => {}}
							disableContextMenu={disableContextMenu}
							trigger={<BranchPillTrigger label={names[0]!} />}
						/>
					</TooltipProvider>,
				);
			});
			const menu = document.querySelector('[role="dialog"]');
			for (const className of BRANCH_DROPDOWN_CLASS_NAME.split(" ")) {
				expect(menu?.classList.contains(className)).toBe(true);
			}
			for (const name of names) {
				const label = Array.from(menu!.querySelectorAll("button span")).find(
					(span) => span.textContent === name.replace(/^origin\//, ""),
				);
				expect(label).toBeDefined();
				await act(async () => {
					const event = new MouseEvent("pointermove", { bubbles: true });
					Object.defineProperty(event, "pointerType", { value: "mouse" });
					label!.dispatchEvent(event);
					await new Promise((resolve) => setTimeout(resolve, 180));
				});
				expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(name);
				await act(async () =>
					label!.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })),
				);
			}
		},
	);

	it.each([false, true])("explains detached task worktrees with folder grouping %s", async (groupBranchesByFolder) => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BranchSelectorPopover
						isOpen
						onOpenChange={() => {}}
						branches={[createDetachedRef()]}
						groupBranchesByFolder={groupBranchesByFolder}
						currentBranch={null}
						worktreeBranches={new Map()}
						onSelectBranchView={() => {}}
						detachedWorktreeBaseRef="main"
						detachedWorktreeHeadCommit="deadbeef12345678"
						trigger={<button type="button">Branch</button>}
					/>
				</TooltipProvider>,
			);
		});

		expect(document.body.textContent).toContain("HEAD (deadbee)");
		expect(document.body.textContent).toContain("detached from main");
		expect(document.body.textContent).toContain("Independent task worktree.");
	});
});
