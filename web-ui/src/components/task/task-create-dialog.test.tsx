import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCreateDialog } from "@/components/task/task-create-dialog";
import type { TaskImage } from "@/types";

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

vi.mock("@/components/ui/dialog", () => ({
	Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
	DialogHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
	DialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/git/branch-select-dropdown", () => ({
	BranchSelectDropdown: ({
		options,
		selectedValue,
		onSelect,
		disabled,
	}: {
		options: Array<{ value: string; label: string }>;
		selectedValue: string;
		onSelect: (value: string) => void;
		disabled?: boolean;
	}) => (
		<select
			name="base-ref"
			aria-label="Base ref"
			value={selectedValue}
			onChange={(event) => onSelect(event.currentTarget.value)}
			disabled={disabled}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
}));

vi.mock("@/components/task/task-prompt-composer", () => ({
	TaskPromptComposer: ({
		value,
		onValueChange,
		images,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		images?: TaskImage[];
	}) => (
		<div>
			<textarea
				name="task-prompt"
				aria-label="Task prompt"
				value={value}
				onChange={(event) => onValueChange(event.currentTarget.value)}
			/>
			<div data-testid="composer-image-count">{images?.length ?? 0}</div>
		</div>
	),
}));

interface HarnessProps {
	initialPrompt: string;
	initialImages?: TaskImage[];
	onCreate?: (options?: { keepDialogOpen?: boolean }) => string | null;
}

function createImage(id: string): TaskImage {
	return {
		id,
		data: "ZmFrZQ==",
		mimeType: "image/png",
		name: `${id}.png`,
	};
}

function Harness({ initialPrompt, initialImages = [], onCreate = () => "task-1" }: HarnessProps): React.ReactElement {
	const [prompt, setPrompt] = useState(initialPrompt);
	const [images, setImages] = useState<TaskImage[]>(initialImages);
	return (
		<TaskCreateDialog
			open
			onOpenChange={() => {}}
			prompt={prompt}
			onPromptChange={setPrompt}
			images={images}
			onImagesChange={setImages}
			onCreate={onCreate}
			onCreateAndStart={() => "task-2"}
			onCreateStartAndOpen={() => "task-3"}
			onCreateMultiple={(prompts) => prompts.map((taskPrompt, index) => `${taskPrompt}-${index}`)}
			onCreateAndStartMultiple={(prompts) => prompts.map((taskPrompt, index) => `${taskPrompt}-${index}`)}
			autoReviewEnabled={false}
			onAutoReviewEnabledChange={() => {}}
			useWorktree
			onUseWorktreeChange={() => {}}
			createFeatureBranch={false}
			onCreateFeatureBranchChange={() => {}}
			branchName=""
			onBranchNameEdit={() => {}}
			onGenerateBranchName={() => {}}
			isGeneratingBranchName={false}
			projectId="project-1"
			currentBranch="main"
			branchRef="main"
			branchOptions={[{ value: "main", label: "main" }]}
			onBranchRefChange={() => {}}
			defaultBaseRef="main"
			onSetDefaultBaseRef={() => {}}
		/>
	);
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.replace(/\s+/g, " ").trim().includes(text),
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Expected button with text "${text}".`);
	}
	return button;
}

function requireTextarea(container: HTMLElement): HTMLTextAreaElement {
	const textarea = container.querySelector('textarea[aria-label="Task prompt"]');
	if (!(textarea instanceof HTMLTextAreaElement)) {
		throw new Error("Expected a task prompt textarea.");
	}
	return textarea;
}

describe("TaskCreateDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
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
		localStorage.clear();
	});

	it("switches to multi-task mode and merges edits back into the single prompt", async () => {
		await act(async () => {
			root.render(<Harness initialPrompt={"1. Draft changelog\n2. Ship beta"} />);
		});

		await act(async () => {
			findButtonByText(container, "Split into 2 tasks").click();
		});

		expect(container.textContent).toContain("New tasks (2)");

		const multiPromptInputs = Array.from(container.querySelectorAll('input[placeholder="Describe the task..."]'));
		const secondPromptInput = multiPromptInputs[1];
		if (!(secondPromptInput instanceof HTMLInputElement)) {
			throw new Error("Expected the second multi-task input.");
		}

		await act(async () => {
			const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			valueSetter?.call(secondPromptInput, "Prepare release notes");
			secondPromptInput.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			findButtonByText(container, "Back to single prompt").click();
		});

		expect(requireTextarea(container).value).toBe("1. Draft changelog\n2. Prepare release notes");
	});

	it("resets the composer when create-more is enabled and a task is created", async () => {
		const onCreate = vi.fn(() => "task-1");

		await act(async () => {
			root.render(
				<Harness initialPrompt="Review login flow" initialImages={[createImage("img-1")]} onCreate={onCreate} />,
			);
		});

		const createMoreToggle = container.querySelector('button[role="switch"]');
		if (!(createMoreToggle instanceof HTMLButtonElement)) {
			throw new Error("Expected a create-more switch.");
		}

		await act(async () => {
			createMoreToggle.click();
		});

		await act(async () => {
			findButtonByText(container, "Create").click();
		});

		expect(onCreate).toHaveBeenCalledWith({ keepDialogOpen: true });
		expect(requireTextarea(container).value).toBe("");
		expect(container.querySelector('[data-testid="composer-image-count"]')?.textContent).toBe("0");
		expect(container.textContent).toContain("New task");
	});

	it("does not render the start-in-plan-mode toggle in the create dialog", async () => {
		await act(async () => {
			root.render(<Harness initialPrompt="Review login flow" />);
		});

		expect(container.textContent).not.toContain("Start in plan mode");
		expect(container.querySelector('[aria-label="Start in plan mode"]')).toBeNull();
	});
});
