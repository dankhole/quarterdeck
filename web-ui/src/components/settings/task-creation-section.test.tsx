import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInitialValues } from "@/hooks/settings/settings-form";
import type { SettingsSectionProps } from "./settings-section-props";
import { TaskCreationSection } from "./task-creation-section";

describe("TaskCreationSection", () => {
	let container: HTMLDivElement;
	let root: Root;
	const setField = vi.fn();

	beforeEach(() => {
		setField.mockReset();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(overrides: Partial<SettingsSectionProps> & { folderOnly?: boolean } = {}) {
		act(() => {
			root.render(
				<TaskCreationSection
					fields={resolveInitialValues(null)}
					setField={setField}
					disabled={false}
					projectName="Example project"
					{...overrides}
				/>,
			);
		});
	}

	function radio(value: string): HTMLInputElement {
		return container.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
	}

	function associatedText(element: Element, attribute: string): string {
		return (element.getAttribute(attribute) ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent ?? "")
			.join(" ");
	}

	it("uses one named native radio group and maps shared=false, isolated=true", () => {
		render();
		expect(container.querySelector("legend")?.textContent).toBe("Default task workspace");
		expect(radio("shared").type).toBe("radio");
		expect(radio("isolated").name).toBe(radio("shared").name);
		expect(radio("isolated").checked).toBe(true);
		expect(radio("shared").checked).toBe(false);
		expect(associatedText(radio("shared"), "aria-labelledby")).toBe("Shared project checkout");
		expect(associatedText(radio("isolated"), "aria-labelledby")).toBe("Isolated worktree");
		expect(associatedText(radio("shared"), "aria-describedby")).toContain("conflicts");
		expect(associatedText(radio("isolated"), "aria-describedby")).toContain("separate working copy");
		expect(associatedText(radio("isolated"), "aria-describedby")).not.toContain("branch");

		act(() => radio("shared").click());
		expect(setField).toHaveBeenLastCalledWith("defaultUseWorktree", false);
		render({ fields: { ...resolveInitialValues(null), defaultUseWorktree: false } });
		expect(radio("shared").checked).toBe(true);
		expect(radio("isolated").checked).toBe(false);
		radio("shared").focus();
		expect(document.activeElement).toBe(radio("shared"));
		act(() => radio("isolated").click());
		expect(setField).toHaveBeenLastCalledWith("defaultUseWorktree", true);
	});

	it("names the target project and explains new-task scope and shared conflicts", () => {
		render({ fields: { ...resolveInitialValues(null), defaultUseWorktree: false } });
		const description = associatedText(container.querySelector("fieldset")!, "aria-describedby");
		expect(description).toContain("new tasks in Example project");
		expect(description).toContain("override this choice for each new task");
		expect(description).toContain("Existing tasks are unchanged");
		expect(container.textContent).toContain("Shared workspace warning:");
		expect(container.textContent).toContain("Concurrent tasks");
		expect(container.textContent).toContain("overwrite each other’s changes");
	});

	it.each([true, false])(
		"shows a conflict warning only when shared is selected (isolated=%s)",
		(defaultUseWorktree) => {
			render({ fields: { ...resolveInitialValues(null), defaultUseWorktree } });
			expect(container.textContent?.includes("Shared workspace warning:")).toBe(!defaultUseWorktree);
			const sharedDescriptions = (radio("shared").getAttribute("aria-describedby") ?? "").split(" ");
			expect(sharedDescriptions).toHaveLength(defaultUseWorktree ? 1 : 2);
		},
	);

	it.each([
		{ defaultUseWorktree: true, folderOnly: false },
		{ defaultUseWorktree: false, folderOnly: false },
		{ defaultUseWorktree: true, folderOnly: true },
		{ defaultUseWorktree: false, folderOnly: true },
	])("keeps every accessible description target present for %o", ({ defaultUseWorktree, folderOnly }) => {
		render({ folderOnly, fields: { ...resolveInitialValues(null), defaultUseWorktree } });
		for (const element of container.querySelectorAll("[aria-describedby]")) {
			for (const id of element.getAttribute("aria-describedby")!.split(" ")) {
				expect(document.getElementById(id)?.textContent?.trim()).toBeTruthy();
			}
		}
	});

	it.each([true, false])(
		"shows a fixed folder workspace without changing saved preference %s",
		(defaultUseWorktree) => {
			render({
				folderOnly: true,
				fields: { ...resolveInitialValues(null), defaultUseWorktree, worktreeSetupScript: "npm ci" },
			});
			expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
			expect(container.textContent).toContain("Shared project folder (fixed)");
			expect(container.textContent).toContain("New tasks in Example project always use this project’s folder");
			expect(container.textContent).toContain("Worktree setup does not run for folder projects");
			expect(container.textContent).toContain("Shared workspace warning:");
			const textarea = container.querySelector("textarea")!;
			expect(textarea.disabled).toBe(true);
			expect(textarea.value).toBe("npm ci");
			expect(setField).not.toHaveBeenCalled();
		},
	);

	it("retains the setup textarea contract and writes only its draft", () => {
		render({ fields: { ...resolveInitialValues(null), worktreeSetupScript: "npm ci" } });
		const textarea = container.querySelector<HTMLTextAreaElement>("#runtime-settings-worktree-setup")!;
		expect(container.querySelector(`label[for="${textarea.id}"]`)?.textContent).toBe("Worktree setup script");
		expect(associatedText(textarea, "aria-describedby")).toContain(".worktreeinclude");
		expect(associatedText(textarea, "aria-describedby")).toContain("Leave blank to skip setup");
		expect(textarea.value).toBe("npm ci");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			setter?.call(textarea, "pnpm install");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(setField).toHaveBeenCalledExactlyOnceWith("worktreeSetupScript", "pnpm install");
		const details = container.querySelector("details")!;
		expect(details.textContent).toContain("sh on macOS/Linux and PowerShell on Windows");
		expect(details.textContent).toContain("10-minute limit");
		expect(details.textContent).toContain("failed setup blocks agent launch until you retry");
		expect(details.textContent).toContain("Successful setup does not run again on resume");
	});

	it.each([true, false])(
		"disables project controls through the native fieldset (isolated=%s)",
		(defaultUseWorktree) => {
			render({ disabled: true, fields: { ...resolveInitialValues(null), defaultUseWorktree } });
			expect(container.querySelector("fieldset")?.disabled).toBe(true);
			expect(radio("shared").matches(":disabled")).toBe(true);
			expect(radio("isolated").matches(":disabled")).toBe(true);
			expect(radio("shared").disabled).toBe(false);
			expect(radio("isolated").disabled).toBe(false);
			expect(container.querySelector("textarea")?.disabled).toBe(true);
			act(() => {
				radio("shared").click();
				radio("isolated").click();
			});
			expect(setField).not.toHaveBeenCalled();
		},
	);
});
