import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInitialValues } from "@/hooks/settings/settings-form";
import { resetAllTerminalRenderers } from "@/terminal/terminal-pool";
import { HarnessSection } from "./agent-section";
import { TerminalSection } from "./display-sections";
import { TroubleshootingSection } from "./general-sections";
import { ShortcutsSection } from "./shortcuts-section";

vi.mock("@/terminal/terminal-pool", () => ({ resetAllTerminalRenderers: vi.fn() }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("settings section action scope and save behavior", () => {
	let root: Root;
	let container: HTMLDivElement;
	let previousActEnvironment: boolean | undefined;
	beforeEach(() => {
		previousActEnvironment = reactTestGlobal.IS_REACT_ACT_ENVIRONMENT;
		reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		vi.clearAllMocks();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	function button(text: string): HTMLButtonElement {
		const match = Array.from(container.querySelectorAll("button")).find((element) =>
			element.textContent?.includes(text),
		);
		if (!match) throw new Error(`Missing button: ${text}`);
		return match;
	}

	it("restores the agent context template only into the settings draft", () => {
		const setField = vi.fn();
		act(() =>
			root.render(
				<HarnessSection
					fields={{ ...resolveInitialValues(null), worktreeSystemPromptTemplate: "Custom context" }}
					setField={setField}
					disabled={false}
					config={null}
				/>,
			),
		);
		act(() => button("Worktree context prompt").click());
		expect(container.querySelector("h3")?.textContent).toContain("Agent launch settings");
		expect(container.textContent).toContain("Use default template only changes this draft");
		expect(container.textContent).toContain("It takes effect when you choose Save changes");
		act(() => button("Use default template").click());
		expect(setField).toHaveBeenCalledExactlyOnceWith("worktreeSystemPromptTemplate", "");
	});

	it("labels layout reset as immediate window recovery and explains shared saved preferences", () => {
		const reset = vi.fn();
		act(() => root.render(<TroubleshootingSection onResetLayout={reset} />));
		expect(container.querySelector("h3")?.textContent).toContain("Layout recovery");
		expect(container.textContent).toContain("Saved layout preferences are shared with other windows");
		expect(container.textContent).toContain("Cancel will not undo this action");
		expect(reset).not.toHaveBeenCalled();
		act(() => button("Reset this window's layout now").click());
		expect(reset).toHaveBeenCalledOnce();
	});

	it("resets terminal rendering immediately in this window without saving form changes", () => {
		const setField = vi.fn();
		act(() =>
			root.render(<TerminalSection fields={resolveInitialValues(null)} setField={setField} disabled={false} />),
		);
		expect(container.querySelector("h3")?.textContent).toContain("Terminal");
		expect(container.textContent).toContain("re-render all terminals in this window");
		expect(container.textContent).toContain("Other windows and running agents are unchanged");
		expect(container.textContent).toContain("This does not save form changes");
		expect(resetAllTerminalRenderers).not.toHaveBeenCalled();
		act(() => button("Reset window terminal rendering now").click());
		expect(resetAllTerminalRenderers).toHaveBeenCalledOnce();
		expect(setField).not.toHaveBeenCalled();
	});

	it("distinguishes repeated command fields by their shortcut group", () => {
		act(() =>
			root.render(
				<ShortcutsSection
					fields={{
						...resolveInitialValues(null),
						shortcuts: [
							{ label: "Test", command: "npm test" },
							{ label: "Build", command: "npm run build" },
						],
					}}
					setField={vi.fn()}
					disabled={false}
				/>,
			),
		);
		const groups = container.querySelectorAll('[role="group"]');
		expect(Array.from(groups, (group) => group.getAttribute("aria-label"))).toEqual([
			"Command shortcut 1",
			"Command shortcut 2",
		]);
		expect(groups[0]?.querySelector('input[name="project-shortcut-command-0"]')).not.toBeNull();
		expect(groups[1]?.querySelector('input[name="project-shortcut-command-1"]')).not.toBeNull();
	});

	it("keeps project command drafts distinct from global prompts and focuses a newly added row", () => {
		const frames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			frames.push(callback);
			return frames.length;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
		const fields = { ...resolveInitialValues(null), shortcuts: [] };
		const setField = vi.fn();
		act(() => root.render(<ShortcutsSection fields={fields} setField={setField} disabled={false} />));
		expect(container.querySelector("h3")?.textContent).toContain("Shell command shortcuts");
		expect(container.textContent).toContain("separate from global prompt shortcuts");
		expect(container.textContent).toContain("Command changes take effect after Save changes");
		expect(container.textContent).not.toContain("Restore defaults");
		act(() => button("Add command").click());
		expect(setField).toHaveBeenCalledExactlyOnceWith("shortcuts", [{ label: "Run", command: "", icon: "play" }]);
		act(() =>
			root.render(
				<ShortcutsSection
					fields={{ ...fields, shortcuts: [{ label: "Run", command: "", icon: "play" }] }}
					setField={setField}
					disabled={false}
				/>,
			),
		);
		const input = container.querySelector<HTMLInputElement>('input[name="project-shortcut-label-0"]');
		const row = input?.closest("div");
		const scrollIntoView = vi.fn();
		Object.defineProperty(row, "scrollIntoView", { configurable: true, value: scrollIntoView });
		act(() => frames.at(-1)?.(0));
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
		expect(document.activeElement).toBe(input);
	});
});
