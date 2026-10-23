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

describe("TaskPiOptions", () => {
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

	it("discovers provider-qualified models inside the dialog and preserves inherit by default", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		expect(document.querySelector('[aria-label="Starting model"]')?.textContent).toContain("Pi default");
		expect(query).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();
		await openMenu("Starting model");
		expect(document.querySelector('[role="dialog"]')?.contains(document.querySelector('[role="menu"]'))).toBe(true);
		await choose("beta/shared-model");
		expect(onChange).toHaveBeenLastCalledWith({ model: { provider: "beta", id: "shared-model" } });
		await openMenu("Starting model");
		await choose("Pi default");
		expect(onChange).toHaveBeenLastCalledWith(undefined);
		expect(document.body.textContent).toContain("Extension-defined models may be absent");
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
		expect(document.querySelector('[aria-label="Starting model"]')?.textContent).toContain("Pi default");
	});
});
