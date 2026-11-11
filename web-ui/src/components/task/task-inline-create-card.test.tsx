import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskInlineCreateCard } from "@/components/task/task-inline-create-card";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("react-hotkeys-hook", () => ({ useHotkeys: () => {} }));
vi.mock("@/components/task/task-prompt-composer", () => ({ TaskPromptComposer: () => null }));

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("TaskInlineCreateCard branch grouping", () => {
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

	it.each([undefined, false, true])(
		"uses grouping %s without changing the selected canonical branch",
		async (groupBranchesByFolder) => {
			const onBranchRefChange = vi.fn();
			await act(async () =>
				root.render(
					<TooltipProvider>
						<TaskInlineCreateCard
							prompt="Task"
							onPromptChange={() => {}}
							onCreate={() => {}}
							projectId="project-1"
							branchRef="feature/nested/a"
							branchOptions={[{ value: "feature/nested/a", label: "feature/nested/a (current)" }]}
							onBranchRefChange={onBranchRefChange}
							groupBranchesByFolder={groupBranchesByFolder}
						/>
					</TooltipProvider>,
				),
			);
			await act(async () => container.querySelector<HTMLButtonElement>("#inline-task-branch-select")?.click());
			const menu = document.querySelector('[data-radix-popper-content-wrapper] > [role="dialog"]');
			expect(menu).not.toBeNull();
			expect(menu?.querySelectorAll("button[aria-expanded]").length).toBe(groupBranchesByFolder ? 2 : 0);
			const leaf = Array.from(menu!.querySelectorAll("button")).find(
				(button) => !button.hasAttribute("aria-expanded"),
			);
			expect(leaf?.textContent).toBe(groupBranchesByFolder ? "a (current)" : "feature/nested/a (current)");
			await act(async () => leaf?.click());
			expect(onBranchRefChange).toHaveBeenCalledExactlyOnceWith("feature/nested/a");
		},
	);
});
