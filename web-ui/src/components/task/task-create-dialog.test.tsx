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

vi.mock("@/components/task/task-agent-selector", () => ({
	TaskAgentSelector: ({
		agents,
		value,
		onValueChange,
	}: {
		agents: Array<{ id: string; label: string }>;
		value: string;
		onValueChange: (value: "claude" | "codex" | "pi") => void;
	}) => (
		<select
			name="agent-harness"
			aria-label="Task harness"
			value={value}
			onChange={(event) => onValueChange(event.currentTarget.value as "claude" | "codex" | "pi")}
		>
			{agents.map((agent) => (
				<option key={agent.id} value={agent.id}>
					{agent.label}
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
	onCreateMultiple?: (prompts: string[]) => string[];
}

function createImage(id: string): TaskImage {
	return {
		id,
		data: "ZmFrZQ==",
		mimeType: "image/png",
		name: `${id}.png`,
	};
}

function Harness({
	initialPrompt,
	initialImages = [],
	onCreate = () => "task-1",
	onCreateMultiple = (prompts) => prompts.map((taskPrompt, index) => `${taskPrompt}-${index}`),
}: HarnessProps): React.ReactElement {
	const [prompt, setPrompt] = useState(initialPrompt);
	const [images, setImages] = useState<TaskImage[]>(initialImages);
	const [agentId, setAgentId] = useState<"claude" | "codex" | "pi">("claude");
	const [useWorktree, setUseWorktree] = useState(true);
	const [createFeatureBranch, setCreateFeatureBranch] = useState(false);
	return (
		<TaskCreateDialog
			open
			onOpenChange={() => {}}
			prompt={prompt}
			onPromptChange={setPrompt}
			images={images}
			onImagesChange={setImages}
			agentOptions={[
				{
					id: "claude",
					label: "Claude Code",
					binary: "claude",
					command: "claude",
					defaultArgs: [],
					status: "installed",
					statusMessage: null,
					installed: true,
					configured: true,
				},
				{
					id: "codex",
					label: "OpenAI Codex",
					binary: "codex",
					command: "codex",
					defaultArgs: [],
					status: "installed",
					statusMessage: null,
					installed: true,
					configured: false,
				},
			]}
			agentId={agentId}
			onAgentIdChange={setAgentId}
			onCreate={onCreate}
			onCreateAndStart={() => "task-2"}
			onCreateStartAndOpen={() => "task-3"}
			onCreateMultiple={onCreateMultiple}
			useWorktree={useWorktree}
			onUseWorktreeChange={setUseWorktree}
			createFeatureBranch={createFeatureBranch}
			onCreateFeatureBranchChange={setCreateFeatureBranch}
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

function findSwitchByLabel(container: HTMLElement, text: string): HTMLButtonElement {
	const label = Array.from(container.querySelectorAll("label")).find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	const toggle = label?.querySelector('button[role="switch"]');
	if (!(toggle instanceof HTMLButtonElement) || label?.htmlFor !== toggle.id) {
		throw new Error(`Expected a labelled switch for "${text}".`);
	}
	return toggle;
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

	it.each(["ctrlKey", "metaKey"] as const)("creates multiple tasks once with %s+Enter", async (modifier) => {
		const onCreateMultiple = vi.fn(() => ["task-1", "task-2"]);
		await act(async () => {
			root.render(
				<Harness initialPrompt={"1. Draft changelog\n2. Ship beta"} onCreateMultiple={onCreateMultiple} />,
			);
		});
		await act(async () => findButtonByText(container, "Split into 2 tasks").click());
		const input = container.querySelector<HTMLInputElement>('input[name="task-prompt-1"]');
		expect(input).not.toBeNull();
		await act(async () => {
			input?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true, cancelable: true }),
			);
		});
		expect(onCreateMultiple).toHaveBeenCalledExactlyOnceWith(["Draft changelog", "Ship beta"], {
			keepDialogOpen: false,
		});
	});

	it("keeps the last task row without creating tasks when remove is clicked", async () => {
		const onCreateMultiple = vi.fn(() => ["task-1"]);
		await act(async () => {
			root.render(
				<Harness initialPrompt={"1. Draft changelog\n2. Ship beta"} onCreateMultiple={onCreateMultiple} />,
			);
		});
		await act(async () => findButtonByText(container, "Split into 2 tasks").click());
		await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove task 2"]')?.click());
		await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove task 1"]')?.click());
		expect(onCreateMultiple).not.toHaveBeenCalled();
		const inputs = container.querySelectorAll<HTMLInputElement>('input[placeholder="Describe the task..."]');
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.value).toBe("Draft changelog");
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

		const createMoreToggle = findSwitchByLabel(container, "Create more");

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

	it("preserves feature-branch selection while isolation disables branch controls", async () => {
		await act(async () => {
			root.render(<Harness initialPrompt="Review login flow" />);
		});

		const isolationToggle = findSwitchByLabel(container, "Use isolated worktree");
		const featureBranchToggle = findSwitchByLabel(container, "Create feature branch");
		const baseRef = container.querySelector<HTMLSelectElement>('select[aria-label="Base ref"]');
		expect(isolationToggle.getAttribute("aria-checked")).toBe("true");
		expect(featureBranchToggle.getAttribute("aria-checked")).toBe("false");
		expect(featureBranchToggle.disabled).toBe(false);
		expect(baseRef?.disabled).toBe(false);

		await act(async () => featureBranchToggle.click());
		expect(featureBranchToggle.getAttribute("aria-checked")).toBe("true");
		expect(container.querySelector('input[name="feature-branch-name"]')).not.toBeNull();

		await act(async () => isolationToggle.click());
		expect(isolationToggle.getAttribute("aria-checked")).toBe("false");
		expect(featureBranchToggle.disabled).toBe(true);
		expect(baseRef?.disabled).toBe(true);
		expect(container.querySelector('input[name="feature-branch-name"]')).toBeNull();
		expect(container.textContent).toContain("Without isolation, the task runs directly on");

		await act(async () => featureBranchToggle.click());
		expect(featureBranchToggle.getAttribute("aria-checked")).toBe("true");

		await act(async () => isolationToggle.click());
		expect(featureBranchToggle.disabled).toBe(false);
		expect(baseRef?.disabled).toBe(false);
		expect(container.querySelector('input[name="feature-branch-name"]')).not.toBeNull();

		await act(async () => featureBranchToggle.click());
		expect(featureBranchToggle.getAttribute("aria-checked")).toBe("false");
		expect(container.querySelector('input[name="feature-branch-name"]')).toBeNull();
	});

	it("renders the task harness picker in the create flow", async () => {
		await act(async () => {
			root.render(<Harness initialPrompt="Review login flow" />);
		});

		const selector = container.querySelector('select[aria-label="Task harness"]') as HTMLSelectElement | null;
		expect(selector).toBeInstanceOf(HTMLSelectElement);
		expect(selector?.value).toBe("claude");

		await act(async () => {
			const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
			valueSetter?.call(selector, "codex");
			selector?.dispatchEvent(new Event("change", { bubbles: true }));
		});

		expect(selector?.value).toBe("codex");
	});
});
