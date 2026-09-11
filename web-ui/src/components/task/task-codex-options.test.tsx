import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCodexOptions } from "@/components/task/task-codex-options";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import type { RuntimeCodexOptions } from "@/runtime/types";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { codexModels: { query } } }),
}));

const models = [
	{
		id: "model-a",
		model: "model-a",
		displayName: "Model A",
		defaultReasoningEffort: "medium",
		isDefault: true,
		supportedReasoningEfforts: [
			{ reasoningEffort: "low", description: "Quick answers" },
			{ reasoningEffort: "medium", description: "Balanced reasoning" },
		],
	},
	{
		id: "model-b",
		model: "model-b",
		displayName: "Model B",
		defaultReasoningEffort: "high",
		isDefault: false,
		supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deeper reasoning" }],
	},
];

function Harness({
	onChange,
	initial,
}: {
	onChange: (value: RuntimeCodexOptions | undefined) => void;
	initial?: RuntimeCodexOptions;
}) {
	const [value, setValue] = useState<RuntimeCodexOptions | undefined>(initial);
	return (
		<Dialog open onOpenChange={vi.fn()}>
			<DialogHeader title="New task" />
			<DialogBody>
				<TaskCodexOptions
					projectId="project-1"
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
	const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) =>
		element.textContent?.startsWith(label),
	);
	if (!item) throw new Error(`Missing choice ${label}`);
	await act(async () => {
		item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
	});
}

describe("TaskCodexOptions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		query.mockReset().mockResolvedValue({ models });
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

	it("defaults overrides off, discovers models only on opt-in, and clears disabled overrides", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
		if (!toggle) throw new Error("Missing override toggle");
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(document.querySelector('[aria-label="Starting model"]')).toBeNull();
		expect(query).not.toHaveBeenCalled();
		await act(async () => toggle.click());
		expect(query).toHaveBeenCalledOnce();
		await openMenu("Starting model");
		await choose("Model A");
		await openMenu("Reasoning level");
		await choose("Low");
		await act(async () => toggle.click());
		expect(onChange).toHaveBeenLastCalledWith(undefined);
		expect(document.querySelector('[aria-label="Starting model"]')).toBeNull();
		await act(async () => toggle.click());
		expect(onChange).toHaveBeenLastCalledWith({});
		expect(document.querySelector('[aria-label="Starting model"]')?.textContent).toContain("Codex default");
		expect(document.querySelector('[aria-label="Reasoning level"]')?.textContent).toContain("Codex default");
	});

	it("selects provider models and only their supported efforts inside the dialog", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} initial={{}} />));
		expect(document.querySelector<HTMLButtonElement>('[aria-label="Reasoning level"]')?.disabled).toBe(true);
		await openMenu("Starting model");
		expect(document.querySelector('[role="dialog"]')?.contains(document.querySelector('[role="menu"]'))).toBe(true);
		await choose("Model A");
		await openMenu("Reasoning level");
		expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("High");
		await choose("Low");
		expect(onChange).toHaveBeenLastCalledWith({ model: "model-a", reasoningEffort: "low" });
		await openMenu("Starting model");
		await choose("Model B");
		expect(onChange).toHaveBeenLastCalledWith({ model: "model-b" });
		await openMenu("Reasoning level");
		expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Low");
		await choose("High");
		expect(onChange).toHaveBeenLastCalledWith({ model: "model-b", reasoningEffort: "high" });
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});

	it("lets saved overrides be cleared when model discovery fails", async () => {
		query.mockRejectedValue(new Error("Unavailable"));
		const onChange = vi.fn();
		await act(async () =>
			root.render(<Harness onChange={onChange} initial={{ model: "old-model", reasoningEffort: "high" }} />),
		);
		expect(document.querySelector('[role="status"]')?.textContent).toContain(
			"You can still start with Codex default",
		);
		await openMenu("Starting model");
		await choose("Codex default");
		expect(onChange).toHaveBeenLastCalledWith({});
		expect(document.querySelector('[aria-label="Starting model"]')?.textContent).toContain("Codex default");
	});
});
