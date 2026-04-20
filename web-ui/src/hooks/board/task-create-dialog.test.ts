import { describe, expect, it } from "vitest";
import {
	getValidTaskPrompts,
	joinTaskPromptsForSingleMode,
	resolveEffectivePrimaryStartAction,
	resolveTaskCreateDialogCopy,
	resolveTaskCreateHotkeyAction,
} from "@/hooks/board/task-create-dialog";

describe("task-create-dialog", () => {
	it("filters blank prompts before multi-create actions run", () => {
		expect(getValidTaskPrompts(["Ship release", "   ", "", "Write notes"])).toEqual(["Ship release", "Write notes"]);
	});

	it("joins multi-task prompts back into a numbered single prompt", () => {
		expect(joinTaskPromptsForSingleMode(["Ship release", "   ", "Write notes"])).toBe(
			"1. Ship release\n2. Write notes",
		);
	});

	it("falls back to the default start action when start-and-open is unavailable", () => {
		expect(resolveEffectivePrimaryStartAction("start_and_open", false)).toBe("start");
		expect(resolveEffectivePrimaryStartAction("start_and_open", true)).toBe("start_and_open");
	});

	it("derives dialog copy and hotkey actions from the current workflow mode", () => {
		expect(resolveTaskCreateDialogCopy("multi", 2, "start")).toMatchObject({
			dialogTitle: "New tasks (2)",
			taskCountLabel: "tasks",
			primaryStartLabel: "Start task",
			secondaryStartLabel: "Start and open",
		});
		expect(resolveTaskCreateHotkeyAction("single", { altKey: false, shiftKey: true })).toBe("start_and_open_single");
		expect(resolveTaskCreateHotkeyAction("multi", { altKey: true, shiftKey: false })).toBe("create_all");
	});
});
