import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskPiOptions } from "@/components/task/task-pi-options";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import type { RuntimePiOptions } from "@/runtime/types";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { piModels: { query } } }),
}));

const models = [
	{ provider: "alpha", id: "shared-model" },
	{ provider: "beta", id: "shared-model" },
];

let projectId = 0;

function Harness({
	onChange,
	initial,
}: {
	onChange: (value: RuntimePiOptions | undefined) => void;
	initial?: RuntimePiOptions;
}) {
	const [value, setValue] = useState<RuntimePiOptions | undefined>(initial);
	return (
		<Dialog open onOpenChange={vi.fn()}>
			<DialogHeader title="New task" />
			<DialogBody>
				<TaskPiOptions
					projectId={`project-${projectId}`}
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
	const labelElement = Array.from(document.querySelectorAll("label")).find((element) => element.textContent === label);
	const trigger = labelElement
		? document.getElementById(labelElement.htmlFor)
		: document.querySelector(`button[aria-label="${label}"]`);
	if (!trigger) throw new Error(`Missing ${label}`);
	await act(async () => {
		if (labelElement) trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
		else trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
	});
}

async function choose(label: string): Promise<void> {
	const item = Array.from(
		document.querySelectorAll('[role="menuitem"], [data-radix-popper-content-wrapper] button'),
	).find((element) => element.textContent?.startsWith(label));
	if (!item) throw new Error(`Missing choice ${label}`);
	await act(async () => {
		item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
	});
	// Radix schedules focus restoration when React commits the closed menu.
	// Wait after that commit so it cannot dismiss the next menu we open.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("TaskPiOptions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		projectId += 1;
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

	it("discovers provider-qualified models inside the dialog and preserves inherit by default", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		expect(document.querySelector("label")?.parentElement?.textContent).toContain("Pi default");
		expect(query).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();
		await openMenu("Starting model");
		expect(
			document
				.querySelector('[role="dialog"]')
				?.contains(document.querySelector('input[placeholder="Search models…"]')),
		).toBe(true);
		await choose("beta/shared-model");
		expect(onChange).toHaveBeenLastCalledWith({ model: { provider: "beta", id: "shared-model" } });
		await openMenu("Starting model");
		await choose("Pi default");
		expect(onChange).toHaveBeenLastCalledWith(undefined);
		expect(document.body.textContent).toContain("Extension-defined models may be absent");
	});
	it("filters the catalog by provider text", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		await openMenu("Starting model");
		const input = document.querySelector<HTMLInputElement>('input[placeholder="Search models…"]');
		if (!input) throw new Error("Missing model search");
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "beta");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const choices = Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper] button")).map(
			(item) => item.textContent,
		);
		expect(choices).toContain("beta/shared-model");
		expect(choices).not.toContain("alpha/shared-model");
		await choose("beta/shared-model");
		expect(onChange).toHaveBeenLastCalledWith({ model: models[1] });
	});
	it("reuses discovery after reopening the picker", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		await act(async () => root.render(null));
		await act(async () => root.render(<Harness onChange={onChange} />));
		expect(query).toHaveBeenCalledOnce();
		expect(document.body.textContent).not.toContain("Loading Pi models");
	});
	it("preserves independent model and thinking choices", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		await openMenu("Thinking level");
		await choose("high");
		expect(onChange).toHaveBeenLastCalledWith({ thinkingLevel: "high" });
		await openMenu("Starting model");
		await choose("beta/shared-model");
		expect(onChange).toHaveBeenLastCalledWith({ model: models[1], thinkingLevel: "high" });
		await openMenu("Starting model");
		await choose("Pi default");
		expect(onChange).toHaveBeenLastCalledWith({ thinkingLevel: "high" });
		await openMenu("Thinking level");
		await choose("Pi default");
		expect(onChange).toHaveBeenLastCalledWith(undefined);
	});
	it.each(["failure", "empty", "older runtime"])("keeps default usable on %s", async (kind) => {
		if (kind === "empty") query.mockResolvedValue({ models: [] });
		else
			query.mockRejectedValue(
				new Error(kind === "older runtime" ? 'No procedure found on path "runtime.piModels"' : "Unavailable"),
			);
		const onChange = vi.fn();
		await act(async () =>
			root.render(<Harness onChange={onChange} initial={{ model: { provider: "old", id: "model" } }} />),
		);
		expect(document.querySelector('[role="status"]')?.textContent).toContain("You can still start with Pi default");
		await openMenu("Starting model");
		await choose("Pi default");
		expect(onChange).toHaveBeenLastCalledWith(undefined);
		expect(document.querySelector("label")?.parentElement?.textContent).toContain("Pi default");
	});
});
