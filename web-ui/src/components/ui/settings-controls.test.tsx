import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSwitch } from "./settings-controls";

describe("SettingsSwitch", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("associates its visible name and help, and lets the label toggle the switch", () => {
		const onCheckedChange = vi.fn();
		act(() => {
			root.render(
				<SettingsSwitch
					checked={false}
					onCheckedChange={onCheckedChange}
					disabled={false}
					label="Play task sounds"
					description="Sounds for tasks that need attention."
				/>,
			);
		});

		const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
		const label = document.getElementById(control.getAttribute("aria-labelledby")!);
		const description = document.getElementById(control.getAttribute("aria-describedby")!);
		expect(label?.textContent).toBe("Play task sounds");
		expect(description?.textContent).toBe("Sounds for tasks that need attention.");
		expect(label?.previousElementSibling).toBe(control);
		expect(control.getAttribute("aria-checked")).toBe("false");
		control.focus();
		expect(document.activeElement).toBe(control);
		expect(control.className).toContain("focus-visible:outline-border-focus");
		act(() => label?.click());
		expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
	});

	it("keeps associations unique and omits missing descriptions", () => {
		act(() => {
			root.render(
				<>
					<SettingsSwitch checked onCheckedChange={vi.fn()} disabled={false} label="First" />
					<SettingsSwitch checked={false} onCheckedChange={vi.fn()} disabled={false} label="Second" />
				</>,
			);
		});
		const controls = Array.from(container.querySelectorAll('[role="switch"]'));
		expect(new Set(controls.map((control) => control.id)).size).toBe(2);
		expect(
			controls.map((control) => document.getElementById(control.getAttribute("aria-labelledby")!)?.textContent),
		).toEqual(["First", "Second"]);
		for (const control of controls) expect(control.hasAttribute("aria-describedby")).toBe(false);
	});

	it("does not toggle a disabled switch from its control or label", () => {
		const onCheckedChange = vi.fn();
		act(() => {
			root.render(<SettingsSwitch checked onCheckedChange={onCheckedChange} disabled label="Disabled preference" />);
		});
		const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
		expect(control.disabled).toBe(true);
		act(() => {
			control.click();
			container.querySelector("label")?.click();
		});
		expect(onCheckedChange).not.toHaveBeenCalled();
	});
});
