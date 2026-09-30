import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManagementDialog } from "@/components/app/project-management-dialog";
import type { UseProjectManagementResult } from "@/hooks/project/use-project-management";

vi.mock("@/components/ui/dialog", () => ({
	Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DialogHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
	DialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
	DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("ProjectManagementDialog", () => {
	let root: Root;
	let container: HTMLDivElement;
	let management: UseProjectManagementResult;
	beforeEach(() => {
		container = document.createElement("div");
		root = createRoot(container);
		management = {
			dialog: {
				action: "rename",
				project: {
					id: "p1",
					path: "/projects/project",
					name: "Display name",
					boardRevision: 1,
					taskCounts: { in_progress: 0, review: 2, trash: 0 },
				},
				value: "Display name",
			},
			error: null,
			pendingProjectId: null,
			isPickingFolder: false,
			requestRename: vi.fn(),
			requestLocate: vi.fn(),
			requestRenameFolder: vi.fn(),
			setValue: vi.fn(),
			close: vi.fn(),
			confirm: vi.fn(),
			pickFolder: vi.fn(),
			checkAvailability: vi.fn(),
		};
	});
	afterEach(() => act(() => root.unmount()));
	function render() {
		act(() => root.render(<ProjectManagementDialog management={management} />));
	}
	function button(label: string) {
		const match = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
		if (!match) throw new Error(`Missing button: ${label}`);
		return match;
	}

	it("lets a display name revert to the folder default", () => {
		render();
		act(() => button("Use folder name").click());
		expect(management.setValue).toHaveBeenCalledWith("");
		expect(container.textContent).toContain("Choose the name shown in Quarterdeck");
		expect(container.textContent).not.toContain("Task agents and shells will stop");
	});
	it("shows the exact sibling rename and session consequences before confirmation", () => {
		if (!management.dialog) throw new Error("Missing dialog");
		management.dialog = { ...management.dialog, action: "rename_folder", value: "renamed-$&" };
		render();
		expect(container.textContent).toContain("New location: /projects/renamed-$&");
		expect(container.textContent).toContain("Task agents and shells will stop");
		act(() =>
			container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(management.confirm).toHaveBeenCalledTimes(1);
	});
	it("keeps locate manual path editable and pending operations protected from duplicate submission", () => {
		if (!management.dialog) throw new Error("Missing dialog");
		management.dialog = { ...management.dialog, action: "locate", value: "/new/path" };
		render();
		act(() => button("Browse…").click());
		expect(management.pickFolder).toHaveBeenCalledTimes(1);
		management.pendingProjectId = "p1";
		management.error = "Directory is already registered.";
		render();
		expect(container.querySelector("input")?.disabled).toBe(true);
		expect(button("Cancel").disabled).toBe(true);
		expect(button("Saving…").disabled).toBe(true);
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Directory is already registered.");
	});
});
