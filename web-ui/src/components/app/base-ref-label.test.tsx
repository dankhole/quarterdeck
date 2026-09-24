import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseRefLabel } from "@/components/app/base-ref-label";
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it.each([
		[1, 0, "1 behind local · 0 behind remote", true],
		[0, 2, "0 behind local · 2 behind remote", true],
		[0, 0, "0 behind local · 0 behind remote", false],
		[null, null, "local unavailable · remote unavailable", false],
	] as const)("shows local %s and remote %s without hovering", async (local, remote, label, highlighted) => {
		await act(async () => {
			root.render(
				<BaseRefLabel
					card={createCard()}
					behindBaseCount={local}
					behindRemoteBaseCount={remote}
					branches={[]}
					isLoadingBranches={false}
					requestBranches={() => {}}
					onUpdateBaseRef={() => {}}
					pinnedBranches={[]}
				/>,
			);
		});
		expect(container.textContent).toContain(label);
		expect(container.querySelector(".text-status-blue") !== null).toBe(highlighted);
	});

	it("groups pinned local, local, and remote refs", async () => {
		await act(async () => {
			root.render(
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
				/>,
			);
		});

		const trigger = findButtonByText(container, "from origin/main(local unavailable · remote unavailable)");
		expect(trigger).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			trigger?.click();
		});

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
				<BaseRefLabel
					card={createCard({ baseRef: "main" })}
					behindBaseCount={null}
					behindRemoteBaseCount={null}
					branches={[createRef("main", "branch"), createRef("origin/main", "remote")]}
					isLoadingBranches={false}
					requestBranches={() => {}}
					onUpdateBaseRef={onUpdateBaseRef}
					pinnedBranches={[]}
				/>,
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
				<BaseRefLabel
					card={createCard({ baseRef: "" })}
					behindBaseCount={3}
					behindRemoteBaseCount={3}
					branches={[createRef("main", "branch")]}
					isLoadingBranches={false}
					requestBranches={() => {}}
					onUpdateBaseRef={onUpdateBaseRef}
					pinnedBranches={[]}
				/>,
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

	it("filters across local and remote refs", async () => {
		await act(async () => {
			root.render(
				<BaseRefLabel
					card={createCard({ baseRef: "main" })}
					behindBaseCount={null}
					behindRemoteBaseCount={null}
					branches={[createRef("main", "branch"), createRef("origin/release", "remote")]}
					isLoadingBranches={false}
					requestBranches={() => {}}
					onUpdateBaseRef={() => {}}
					pinnedBranches={[]}
				/>,
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
