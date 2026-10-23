import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskOpencodeOptions } from "@/components/task/task-opencode-options";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import type { RuntimeOpencodeOptions } from "@/runtime/types";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { opencodeCatalog: { query } } }),
}));

const catalog = {
	models: [
		{ id: "anthropic/claude-sonnet", providerId: "anthropic", modelId: "claude-sonnet" },
		{ id: "openai/gpt-5", providerId: "openai", modelId: "gpt-5" },
	],
	agents: [
		{ name: "build", mode: "primary" },
		{ name: "plan", mode: "all" },
	],
};

function Harness({
	onChange,
	initial,
}: {
	onChange: (value: RuntimeOpencodeOptions | undefined) => void;
	initial?: RuntimeOpencodeOptions;
}) {
	const [value, setValue] = useState<RuntimeOpencodeOptions | undefined>(initial);
	return (
		<Dialog open onOpenChange={vi.fn()}>
			<DialogHeader title="New task" />
			<DialogBody>
				<TaskOpencodeOptions
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

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("TaskOpencodeOptions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		query.mockReset().mockResolvedValue(catalog);
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

	it("shows selectors and discovers the catalog immediately without changing defaults", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} />));
		expect(document.querySelector('[aria-label="Agent"]')?.textContent).toContain("opencode default");
		expect(document.querySelector('[aria-label="Starting model"]')?.textContent).toContain("opencode default");
		expect(query).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("selects a catalog agent and a catalog model independently", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} initial={{}} />));
		await openMenu("Agent");
		await choose("build");
		expect(onChange).toHaveBeenLastCalledWith({ agent: "build" });
		await openMenu("Starting model");
		await choose("anthropic / claude-sonnet");
		expect(onChange).toHaveBeenLastCalledWith({ agent: "build", model: "anthropic/claude-sonnet" });
		await openMenu("Agent");
		await choose("opencode default");
		expect(onChange).toHaveBeenLastCalledWith({ model: "anthropic/claude-sonnet" });
	});

	it("supports a validated free-text model when Custom model is chosen", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} initial={{}} />));
		await openMenu("Starting model");
		await choose("Custom model");
		expect(onChange).not.toHaveBeenCalled();
		const input = document.querySelector<HTMLInputElement>('input[aria-label="Custom starting model"]');
		if (!input) throw new Error("Missing custom model input");

		await act(async () => {
			setInputValue(input, "my provider/bad model");
		});
		expect(onChange).not.toHaveBeenCalled();

		await act(async () => {
			setInputValue(input, "mistral/custom-model");
		});
		expect(onChange).toHaveBeenLastCalledWith({ model: "mistral/custom-model" });
	});

	it("shows an existing custom model as free text when it is not in the catalog", async () => {
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} initial={{ model: "self-hosted/llama" }} />));
		const input = document.querySelector<HTMLInputElement>('input[aria-label="Custom starting model"]');
		expect(input?.value).toBe("self-hosted/llama");
	});

	it("lets saved overrides be cleared when catalog discovery fails", async () => {
		query.mockRejectedValue(new Error("Unavailable"));
		const onChange = vi.fn();
		await act(async () => root.render(<Harness onChange={onChange} initial={{ agent: "build" }} />));
		expect(document.querySelector('[role="status"]')?.textContent).toContain("still start with opencode default");
		await openMenu("Agent");
		await choose("opencode default");
		expect(onChange).toHaveBeenLastCalledWith({});
	});
});
