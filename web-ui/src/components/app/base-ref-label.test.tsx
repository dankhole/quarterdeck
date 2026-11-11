import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseRefLabel } from "@/components/app/base-ref-label";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeGitRef } from "@/runtime/types";
import type { BoardCard } from "@/types";

function createRef(name: string, type: RuntimeGitRef["type"]): RuntimeGitRef {
	return {
		name,
		type,
		hash: `${name}-hash`,
		isHead: false,
	};
}

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		title: "Task 1",
		prompt: "Do the thing",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findFolder(name: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-expanded]')).find(
		(button) => button.getAttribute("aria-label")?.startsWith(`${name}, `),
	);
}

describe("BaseRefLabel", () => {
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
		vi.useRealTimers();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderGrouped(props: Partial<ComponentProps<typeof BaseRefLabel>> = {}): Promise<void> {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BaseRefLabel
						card={createCard({ baseRef: "feature/nested/current" })}
						behindBaseCount={null}
						behindRemoteBaseCount={null}
						branches={[
							createRef("feature/pinned", "branch"),
							createRef("feature/nested/current", "branch"),
							createRef("feature/other", "branch"),
							createRef("release/next", "branch"),
							createRef("main", "branch"),
							createRef("origin/feature/remote", "remote"),
							createRef("upstream/feature/remote", "remote"),
						]}
						isLoadingBranches={false}
						requestBranches={() => {}}
						onUpdateBaseRef={() => {}}
						pinnedBranches={["feature/pinned"]}
						groupBranchesByFolder
						{...props}
					/>
				</TooltipProvider>,
			);
		});
		await act(async () => container.querySelector("button")?.click());
	}

	it("keeps Pinned flat and shows nested selected ancestors without merging remote roots", async () => {
		const onUpdateBaseRef = vi.fn();
		await renderGrouped({ onUpdateBaseRef });
		expect(findButtonByText(document.body, "feature/pinned")).not.toBeNull();
		expect(findButtonByText(document.body, "main")).not.toBeNull();
		expect(findFolder("feature")?.getAttribute("aria-expanded")).toBe("true");
		expect(findFolder("feature")?.textContent).toBe("feature2");
		expect(findFolder("nested")?.getAttribute("aria-expanded")).toBe("true");
		expect(findButtonByText(document.body, "current")).not.toBeNull();
		expect(findButtonByText(document.body, "next")).toBeNull();
		expect(findFolder("origin")?.getAttribute("aria-expanded")).toBe("false");
		expect(findFolder("upstream")?.getAttribute("aria-expanded")).toBe("false");
		await act(async () => findFolder("upstream")?.click());
		const remoteFeature = Array.from(
			document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-label^="feature, "]'),
		)[1];
		await act(async () => remoteFeature?.click());
		expect(onUpdateBaseRef).not.toHaveBeenCalled();
		await act(async () => findButtonByText(document.body, "remote")?.click());
		expect(onUpdateBaseRef).toHaveBeenCalledWith("task-1", "upstream/feature/remote", false);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("searches canonical names flat and preserves expansion through no-results and clearing", async () => {
		await renderGrouped();
		await act(async () => findFolder("feature")?.click());
		await act(async () => findFolder("release")?.click());
		const input = document.querySelector<HTMLInputElement>('input[name="base-ref-filter-task-1"]')!;
		await act(async () => setInputValue(input, "feature/remote"));
		expect(findButtonByText(document.body, "origin/feature/remote")).not.toBeNull();
		expect(findButtonByText(document.body, "upstream/feature/remote")).not.toBeNull();
		expect(document.querySelector('[role="dialog"] button[aria-expanded]')).toBeNull();
		await act(async () => setInputValue(input, "nonexistent-branch"));
		expect(document.body.textContent).toContain("No matching refs");
		await act(async () => setInputValue(input, ""));
		expect(findFolder("feature")?.getAttribute("aria-expanded")).toBe("false");
		expect(findFolder("release")?.getAttribute("aria-expanded")).toBe("true");
		await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => container.querySelector("button")?.click());
		expect(findButtonByText(document.body, "current")).not.toBeNull();
		expect(findFolder("release")?.getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps full canonical tooltips and pinned selections when leaves use basenames", async () => {
		vi.useFakeTimers();
		const onUpdateBaseRef = vi.fn();
		await renderGrouped({
			card: createCard({ baseRef: "feature/nested/current", baseRefPinned: true }),
			onUpdateBaseRef,
		});
		const option = findButtonByText(document.body, "other");
		await act(async () => {
			option?.dispatchEvent(
				Object.assign(new MouseEvent("pointermove", { bubbles: true }), { pointerType: "mouse" }),
			);
			await vi.advanceTimersByTimeAsync(200);
		});
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("feature/other");
		await act(async () => option?.click());
		expect(onUpdateBaseRef).toHaveBeenCalledWith("task-1", "feature/other", true);
	});

	it.each([
		[1, 0, "1 behind local · 0 behind remote", true],
		[0, 2, "0 behind local · 2 behind remote", true],
		[0, 0, "0 behind local & remote", false],
		[null, null, "local unavailable · remote unavailable", false],
	] as const)("shows local %s and remote %s without hovering", async (local, remote, label, highlighted) => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BaseRefLabel
						card={createCard()}
						behindBaseCount={local}
						behindRemoteBaseCount={remote}
						branches={[]}
						isLoadingBranches={false}
						requestBranches={() => {}}
						onUpdateBaseRef={() => {}}
						pinnedBranches={[]}
					/>
				</TooltipProvider>,
			);
		});
		expect(container.textContent).toContain(label);
		expect(container.querySelector(".text-status-blue") !== null).toBe(highlighted);
	});

	it("groups pinned local, local, and remote refs", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BaseRefLabel
						card={createCard({ baseRef: "origin/main" })}
						behindBaseCount={null}
						behindRemoteBaseCount={null}
						branches={[
							createRef("main", "branch"),
							createRef("develop", "branch"),
							createRef("origin/main", "remote"),
							createRef("origin/release", "remote"),
						]}
						isLoadingBranches={false}
						requestBranches={() => {}}
						onUpdateBaseRef={() => {}}
						pinnedBranches={["develop"]}
					/>
				</TooltipProvider>,
			);
		});

		const trigger = findButtonByText(container, "from origin/main(local unavailable · remote unavailable)");
		expect(trigger).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			trigger?.click();
		});

		const popover = document.body.querySelector('[role="dialog"]');
		expect(popover?.classList.contains("w-[max(30rem,var(--radix-popover-trigger-width))]")).toBe(true);
		expect(popover?.classList.contains("max-w-[var(--radix-popover-content-available-width)]")).toBe(true);
		expect(document.body.textContent).toContain("Pinned");
		expect(document.body.textContent).toContain("Local");
		expect(document.body.textContent).toContain("Remote");
		expect(findButtonByText(document.body, "develop")).toBeInstanceOf(HTMLButtonElement);
		expect(findButtonByText(document.body, "main")).toBeInstanceOf(HTMLButtonElement);
		expect(findButtonByText(document.body, "origin/main")).toBeInstanceOf(HTMLButtonElement);
		expect(findButtonByText(document.body, "origin/release")).toBeInstanceOf(HTMLButtonElement);
		expect(document.body.querySelector<HTMLInputElement>('input[name="base-ref-filter-task-1"]')?.placeholder).toBe(
			"Filter refs...",
		);
	});

	it("selects remote refs without aliasing them to local branch names", async () => {
		const onUpdateBaseRef = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BaseRefLabel
						card={createCard({ baseRef: "main" })}
						behindBaseCount={null}
						behindRemoteBaseCount={null}
						branches={[createRef("main", "branch"), createRef("origin/main", "remote")]}
						isLoadingBranches={false}
						requestBranches={() => {}}
						onUpdateBaseRef={onUpdateBaseRef}
						pinnedBranches={[]}
					/>
				</TooltipProvider>,
			);
		});

		const trigger = findButtonByText(container, "from main(local unavailable · remote unavailable)");
		await act(async () => {
			trigger?.click();
		});

		const remoteRef = findButtonByText(document.body, "origin/main");
		expect(remoteRef).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			remoteRef?.click();
		});

		expect(onUpdateBaseRef).toHaveBeenCalledWith("task-1", "origin/main", false);
	});

	it("prompts for a base branch when the current base ref is unresolved", async () => {
		const onUpdateBaseRef = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BaseRefLabel
						card={createCard({ baseRef: "" })}
						behindBaseCount={3}
						behindRemoteBaseCount={3}
						branches={[createRef("main", "branch")]}
						isLoadingBranches={false}
						requestBranches={() => {}}
						onUpdateBaseRef={onUpdateBaseRef}
						pinnedBranches={[]}
					/>
				</TooltipProvider>,
			);
		});

		const trigger = findButtonByText(container, "select base branch");
		expect(trigger).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			trigger?.click();
		});

		const baseRef = findButtonByText(document.body, "main");
		await act(async () => {
			baseRef?.click();
		});

		expect(onUpdateBaseRef).toHaveBeenCalledWith("task-1", "main", false);
		expect(document.body.textContent).not.toContain("Unpinned - auto-updates on branch change");
	});

	it.each([
		["main", "branch"],
		["origin/feature/a-very-long-branch-name-with-an-unbroken-segment-that-needs-wrapping", "remote"],
	] as const)("shows the complete %s ref on hover without requiring truncation", async (name, type) => {
		vi.useFakeTimers();
		const onUpdateBaseRef = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BaseRefLabel
						card={createCard()}
						behindBaseCount={null}
						behindRemoteBaseCount={null}
						branches={[createRef(name, type)]}
						isLoadingBranches={false}
						requestBranches={() => {}}
						onUpdateBaseRef={onUpdateBaseRef}
						pinnedBranches={[]}
					/>
				</TooltipProvider>,
			);
		});

		await act(async () => {
			container.querySelector("button")?.click();
		});

		const option = findButtonByText(document.body, name);
		expect(option).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			option?.dispatchEvent(
				Object.assign(new MouseEvent("pointermove", { bubbles: true }), { pointerType: "mouse" }),
			);
			await vi.advanceTimersByTimeAsync(200);
		});

		const tooltip = document.body.querySelector('[role="tooltip"]');
		expect(tooltip?.textContent).toBe(name);
		expect(tooltip?.querySelector(".break-all.whitespace-normal")).not.toBeNull();
		expect(onUpdateBaseRef).not.toHaveBeenCalled();
	});

	it("shows the complete current base ref when hovering its trigger label", async () => {
		vi.useFakeTimers();
		const name = "origin/feature/current-base-with-a-long-name";

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BaseRefLabel
						card={createCard({ baseRef: name })}
						behindBaseCount={null}
						behindRemoteBaseCount={null}
						branches={[]}
						isLoadingBranches={false}
						requestBranches={() => {}}
						onUpdateBaseRef={() => {}}
						pinnedBranches={[]}
					/>
				</TooltipProvider>,
			);
		});

		await act(async () => {
			container
				.querySelector(".font-mono")
				?.dispatchEvent(Object.assign(new MouseEvent("pointermove", { bubbles: true }), { pointerType: "mouse" }));
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(name);
	});

	it("filters across local and remote refs", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BaseRefLabel
						card={createCard({ baseRef: "main" })}
						behindBaseCount={null}
						behindRemoteBaseCount={null}
						branches={[createRef("main", "branch"), createRef("origin/release", "remote")]}
						isLoadingBranches={false}
						requestBranches={() => {}}
						onUpdateBaseRef={() => {}}
						pinnedBranches={[]}
					/>
				</TooltipProvider>,
			);
		});

		const trigger = findButtonByText(container, "from main(local unavailable · remote unavailable)");
		await act(async () => {
			trigger?.click();
		});

		const input = document.body.querySelector<HTMLInputElement>('input[name="base-ref-filter-task-1"]');
		expect(input).toBeInstanceOf(HTMLInputElement);

		await act(async () => {
			if (!input) return;
			setInputValue(input, "release");
		});

		expect(findButtonByText(document.body, "main")).toBeNull();
		expect(findButtonByText(document.body, "origin/release")).toBeInstanceOf(HTMLButtonElement);
		expect(document.body.textContent).toContain("Remote");
	});
});
