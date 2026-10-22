import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskClaudeOptions } from "@/components/task/task-claude-options";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import type { RuntimeClaudeOptions } from "@/runtime/types";

function Harness({
	onChange,
	initial,
}: {
	onChange: (value: RuntimeClaudeOptions | undefined) => void;
	initial?: RuntimeClaudeOptions;
}) {
	const [value, setValue] = useState<RuntimeClaudeOptions | undefined>(initial);
	return (
		<Dialog open onOpenChange={vi.fn()}>
			<DialogHeader title="New task" />
			<DialogBody>
				<TaskClaudeOptions
					value={value}
					onValueChange={(next) => {
						setValue(next);
						onChange(next);
					}}
				/>
			</DialogBody>
		</Dialog>
	);
}

async function openMenu(label: string): Promise<void> {
	const trigger = document.querySelector(`button[aria-label="${label}"]`);
	if (!trigger) throw new Error(`Missing ${label}`);
	await act(async () => {
		trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
	});
}

async function choose(label: string): Promise<void> {
	const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
		(element) => element.textContent === label,
	);
	if (!item) throw new Error(`Missing choice ${label}`);
	await act(async () => {
		item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
	});
}

describe("TaskClaudeOptions", () => {
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
		act(() => root.unmount());
		container.remove();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("defaults both selectors to the inherited Claude configuration", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		expect(document.querySelector('[aria-label="Starting model"]')?.textContent).toContain("Claude default");
		expect(document.querySelector('[aria-label="Effort level"]')?.textContent).toContain("Claude default");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("selects static model aliases and CLI effort levels independently inside the dialog", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		await openMenu("Starting model");
		expect(document.querySelector('[role="dialog"]')?.contains(document.querySelector('[role="menu"]'))).toBe(true);
		const modelLabels = Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent);
		expect(modelLabels).toEqual(["Claude default", "Fable", "Opus", "Sonnet", "Haiku"]);
		await choose("Opus");
		expect(onChange).toHaveBeenLastCalledWith({ model: "opus" });
		await openMenu("Effort level");
		await choose("Extra high");
		expect(onChange).toHaveBeenLastCalledWith({ model: "opus", effort: "xhigh" });
		await openMenu("Starting model");
		await choose("Claude default");
		expect(onChange).toHaveBeenLastCalledWith({ effort: "xhigh" });
		await openMenu("Effort level");
		await choose("Claude default");
		expect(onChange).toHaveBeenLastCalledWith({});
	});
});
