import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptShortcutEditorDialog } from "@/components/settings/prompt-shortcut-editor-dialog";
import type { PromptShortcut } from "@/runtime/types";

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
		input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (nativeInputValueSetter) {
		nativeInputValueSetter.call(input, value);
	}
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PromptShortcutEditorDialog", () => {
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
		document.body.innerHTML = "";
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders existing shortcuts as editable rows", async () => {
		const shortcuts: PromptShortcut[] = [
			{ label: "Docs", prompt: "Write documentation" },
			{ label: "Test", prompt: "Write tests" },
		];

		await act(async () => {
			root.render(
				<PromptShortcutEditorDialog
					open={true}
					onOpenChange={() => {}}
					shortcuts={shortcuts}
					hiddenDefaultPromptShortcuts={[]}
					onSave={async () => true}
				/>,
			);
		});

		const labelInputs = Array.from(document.querySelectorAll("input[type='text']")) as HTMLInputElement[];
		const promptTextareas = Array.from(document.querySelectorAll("textarea")) as HTMLTextAreaElement[];

		expect(labelInputs).toHaveLength(2);
		expect(promptTextareas).toHaveLength(2);

		expect(labelInputs[0]?.value).toBe("Docs");
		expect(promptTextareas[0]?.value).toBe("Write documentation");

		expect(labelInputs[1]?.value).toBe("Test");
		expect(promptTextareas[1]?.value).toBe("Write tests");
	});

	it("adds a new shortcut row", async () => {
		const shortcuts: PromptShortcut[] = [{ label: "Existing", prompt: "Existing prompt" }];

		await act(async () => {
			root.render(
				<PromptShortcutEditorDialog
					open={true}
					onOpenChange={() => {}}
					shortcuts={shortcuts}
					hiddenDefaultPromptShortcuts={[]}
					onSave={async () => true}
				/>,
			);
		});

		let labelInputs = Array.from(document.querySelectorAll("input[type='text']")) as HTMLInputElement[];
		expect(labelInputs).toHaveLength(1);

		const addButton = findButtonByText(document.body, "Add shortcut");
		expect(addButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			addButton?.click();
		});

		labelInputs = Array.from(document.querySelectorAll("input[type='text']")) as HTMLInputElement[];
		const promptTextareas = Array.from(document.querySelectorAll("textarea")) as HTMLTextAreaElement[];

		expect(labelInputs).toHaveLength(2);
		expect(promptTextareas).toHaveLength(2);

		expect(labelInputs[1]?.value).toBe("");
		expect(promptTextareas[1]?.value).toBe("");
	});

	it("deletes a shortcut row", async () => {
		const shortcuts: PromptShortcut[] = [
			{ label: "First", prompt: "First prompt" },
			{ label: "Second", prompt: "Second prompt" },
		];

		await act(async () => {
			root.render(
				<PromptShortcutEditorDialog
					open={true}
					onOpenChange={() => {}}
					shortcuts={shortcuts}
					hiddenDefaultPromptShortcuts={[]}
					onSave={async () => true}
				/>,
			);
		});

		let labelInputs = Array.from(document.querySelectorAll("input[type='text']")) as HTMLInputElement[];
		expect(labelInputs).toHaveLength(2);

		const deleteButtons = Array.from(
			document.querySelectorAll("button[aria-label^='Delete shortcut']"),
		) as HTMLButtonElement[];
		expect(deleteButtons).toHaveLength(2);

		await act(async () => {
			deleteButtons[0]?.click();
		});

		labelInputs = Array.from(document.querySelectorAll("input[type='text']")) as HTMLInputElement[];
		const promptTextareas = Array.from(document.querySelectorAll("textarea")) as HTMLTextAreaElement[];

		expect(labelInputs).toHaveLength(1);
		expect(promptTextareas).toHaveLength(1);

		expect(labelInputs[0]?.value).toBe("Second");
		expect(promptTextareas[0]?.value).toBe("Second prompt");
	});

	it("calls onSave with edited shortcuts", async () => {
		const shortcuts: PromptShortcut[] = [{ label: "Original", prompt: "Original prompt" }];
		const onSave = vi.fn(async () => true);

		await act(async () => {
			root.render(
				<PromptShortcutEditorDialog
					open={true}
					onOpenChange={() => {}}
					shortcuts={shortcuts}
					hiddenDefaultPromptShortcuts={[]}
					onSave={onSave}
				/>,
			);
		});

		const labelInput = document.querySelector("input[type='text']") as HTMLInputElement;
		const promptTextarea = document.querySelector("textarea") as HTMLTextAreaElement;

		await act(async () => {
			setInputValue(labelInput, "Edited");
		});

		await act(async () => {
			setInputValue(promptTextarea, "Edited prompt");
		});

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			saveButton?.click();
		});

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave).toHaveBeenCalledWith([{ label: "Edited", prompt: "Edited prompt" }], []);
	});

	it("disables save when label is empty", async () => {
		const shortcuts: PromptShortcut[] = [{ label: "Valid", prompt: "Valid prompt" }];

		await act(async () => {
			root.render(
				<PromptShortcutEditorDialog
					open={true}
					onOpenChange={() => {}}
					shortcuts={shortcuts}
					hiddenDefaultPromptShortcuts={[]}
					onSave={async () => true}
				/>,
			);
		});

		let saveButton = findButtonByText(document.body, "Save");
		expect(saveButton?.disabled).toBe(false);

		const labelInput = document.querySelector("input[type='text']") as HTMLInputElement;

		await act(async () => {
			setInputValue(labelInput, "");
		});

		saveButton = findButtonByText(document.body, "Save");
		expect(saveButton?.disabled).toBe(true);
	});

	it("shows duplicate label validation error", async () => {
		const shortcuts: PromptShortcut[] = [
			{ label: "Duplicate", prompt: "First prompt" },
			{ label: "Other", prompt: "Second prompt" },
		];

		await act(async () => {
			root.render(
				<PromptShortcutEditorDialog
					open={true}
					onOpenChange={() => {}}
					shortcuts={shortcuts}
					hiddenDefaultPromptShortcuts={[]}
					onSave={async () => true}
				/>,
			);
		});

		expect(document.body.textContent).not.toContain("Duplicate name");

		const labelInputs = Array.from(document.querySelectorAll("input[type='text']")) as HTMLInputElement[];

		await act(async () => {
			setInputValue(labelInputs[1]!, "Duplicate");
		});

		const errorMessages = Array.from(document.querySelectorAll("span.text-status-red"));
		expect(errorMessages).toHaveLength(2);
		expect(errorMessages[0]?.textContent).toBe("Duplicate name");
		expect(errorMessages[1]?.textContent).toBe("Duplicate name");

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton?.disabled).toBe(true);
	});

	it("shows reminder text about skills", async () => {
		await act(async () => {
			root.render(
				<PromptShortcutEditorDialog
					open={true}
					onOpenChange={() => {}}
					shortcuts={[]}
					hiddenDefaultPromptShortcuts={[]}
					onSave={async () => true}
				/>,
			);
		});

		const bodyText = document.body.textContent;
		expect(bodyText).toContain("Enter a full prompt or just invoke a skill");
		expect(bodyText).toContain("/commit");
		expect(bodyText).toContain("The text is pasted into the agent terminal and submitted");
	});
});
