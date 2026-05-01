import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BranchSelectDropdown } from "@/components/git/branch-select-dropdown";
import { TaskAgentSelector } from "@/components/task/task-agent-selector";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import type { RuntimeAgentId } from "@/runtime/types";
import type { TaskAgentDisplayOption } from "@/utils/task-agent-display";

const AGENTS: TaskAgentDisplayOption[] = [
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		command: "claude",
		installed: true,
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		command: "codex",
		installed: true,
	},
];

function dispatchPointerEvent(element: Element, type: "pointerdown" | "pointerup"): void {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
	});
	Object.defineProperty(event, "pointerType", { value: "mouse" });
	element.dispatchEvent(event);
}

function dispatchClick(element: Element): void {
	element.dispatchEvent(
		new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			button: 0,
		}),
	);
}

async function waitForRadixEffects(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function requireElement<T extends Element>(element: T | null, description: string): T {
	if (!element) {
		throw new Error(`Expected ${description}.`);
	}
	return element;
}

function findMenuItemByText(text: string): HTMLElement {
	const menuItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((element) =>
		element.textContent?.includes(text),
	);
	if (!(menuItem instanceof HTMLElement)) {
		throw new Error(`Expected menu item containing "${text}".`);
	}
	return menuItem;
}

function findButtonByText(text: string): HTMLButtonElement {
	const button = Array.from(document.body.querySelectorAll("button")).find((element) =>
		element.textContent?.includes(text),
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Expected button containing "${text}".`);
	}
	return button;
}

function Harness({
	onDialogOpenChange,
	onAgentChange,
}: {
	onDialogOpenChange: (open: boolean) => void;
	onAgentChange: (agentId: RuntimeAgentId) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(true);
	const [agentId, setAgentId] = useState<RuntimeAgentId>("claude");

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				onDialogOpenChange(nextOpen);
				setOpen(nextOpen);
			}}
		>
			<DialogHeader title="New task" />
			<DialogBody>
				<TaskAgentSelector
					agents={AGENTS}
					value={agentId}
					onValueChange={(nextAgentId) => {
						onAgentChange(nextAgentId);
						setAgentId(nextAgentId);
					}}
				/>
			</DialogBody>
		</Dialog>
	);
}

function BranchSelectHarness({
	onDialogOpenChange,
	onBranchSelect,
}: {
	onDialogOpenChange: (open: boolean) => void;
	onBranchSelect: (branchRef: string) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(true);
	const [branchRef, setBranchRef] = useState("main");
	const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				onDialogOpenChange(nextOpen);
				setOpen(nextOpen);
			}}
		>
			<DialogHeader title="New task" />
			<DialogBody>
				<div ref={setPortalContainer}>
					<BranchSelectDropdown
						options={[
							{ value: "main", label: "main" },
							{ value: "develop", label: "develop" },
						]}
						selectedValue={branchRef}
						onSelect={(nextBranchRef) => {
							onBranchSelect(nextBranchRef);
							setBranchRef(nextBranchRef);
						}}
						portalContainer={portalContainer}
					/>
				</div>
			</DialogBody>
		</Dialog>
	);
}

describe("TaskAgentSelector", () => {
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

	it("keeps the create dialog open when the harness changes", async () => {
		const onDialogOpenChange = vi.fn();
		const onAgentChange = vi.fn();

		await act(async () => {
			root.render(<Harness onDialogOpenChange={onDialogOpenChange} onAgentChange={onAgentChange} />);
		});
		await waitForRadixEffects();

		const trigger = requireElement(
			document.body.querySelector('button[aria-label="Task harness"]'),
			"the task harness trigger",
		);
		await act(async () => {
			dispatchPointerEvent(trigger, "pointerdown");
		});
		await waitForRadixEffects();

		const dialogContent = requireElement(document.body.querySelector('[role="dialog"]'), "the create dialog content");
		const codexItem = findMenuItemByText("OpenAI Codex");
		expect(dialogContent.contains(codexItem)).toBe(true);

		await act(async () => {
			dispatchPointerEvent(codexItem, "pointerdown");
			dispatchPointerEvent(codexItem, "pointerup");
			dispatchClick(codexItem);
		});
		await waitForRadixEffects();

		expect(onAgentChange).toHaveBeenCalledWith("codex");
		expect(onDialogOpenChange).not.toHaveBeenCalledWith(false);
		expect(document.body.textContent).toContain("New task");
		expect(trigger.textContent).toContain("OpenAI Codex");
	});

	it("keeps the create dialog open when the base ref changes through a dialog-local portal", async () => {
		const onDialogOpenChange = vi.fn();
		const onBranchSelect = vi.fn();

		await act(async () => {
			root.render(<BranchSelectHarness onDialogOpenChange={onDialogOpenChange} onBranchSelect={onBranchSelect} />);
		});
		await waitForRadixEffects();

		await act(async () => {
			dispatchClick(findButtonByText("main"));
		});
		await waitForRadixEffects();

		const dialogContent = requireElement(document.body.querySelector('[role="dialog"]'), "the create dialog content");
		const developItem = findButtonByText("develop");
		expect(dialogContent.contains(developItem)).toBe(true);

		await act(async () => {
			dispatchPointerEvent(developItem, "pointerdown");
			dispatchPointerEvent(developItem, "pointerup");
			dispatchClick(developItem);
		});
		await waitForRadixEffects();

		expect(onBranchSelect).toHaveBeenCalledWith("develop");
		expect(onDialogOpenChange).not.toHaveBeenCalledWith(false);
		expect(document.body.textContent).toContain("New task");
		expect(findButtonByText("develop").textContent).toContain("develop");
	});
});
