// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RuntimeProjectSummary } from "@/runtime/types";
import {
	getSettingsNavigationGroups,
	getSettingsProjectName,
	getSettingsScopeDescription,
	resolveSettingsProject,
} from "./settings-navigation";

const projects: RuntimeProjectSummary[] = [
	{
		id: "board",
		name: "board-folder",
		path: "/board",
		boardRevision: 0,
		taskCounts: { in_progress: 0, review: 0, trash: 0 },
	},
	{
		id: "settings",
		name: "settings-folder",
		displayName: "Named settings project",
		path: "/settings",
		folderOnly: true,
		boardRevision: 0,
		taskCounts: { in_progress: 0, review: 0, trash: 0 },
	},
];

describe("settings navigation", () => {
	it("groups all categories by scope and only exposes desktop preferences in the desktop", () => {
		const browser = getSettingsNavigationGroups("Atlas", false);
		expect(browser.map((group) => group.label)).toEqual(["All projects", "Project: Atlas", "Tools"]);
		expect(browser[0]?.categories.map((category) => category.title)).toEqual([
			"Agents",
			"Notifications",
			"Terminal & editor",
			"Git branches",
			"Code navigation",
			"Prompt shortcuts",
		]);
		expect(browser[1]?.categories.map((category) => category.id)).toEqual(["task-creation", "shortcuts"]);
		expect(getSettingsNavigationGroups("Atlas", true)[2]?.categories[0]?.id).toBe("runtime-environment");
	});

	it("uses the identity-matched registry entry rather than the first or current board project", () => {
		const project = resolveSettingsProject(projects, "settings");
		expect(getSettingsProjectName(project, "settings")).toBe("Named settings project");
		expect(project?.path).toBe("/settings");
		expect(project?.folderOnly).toBe(true);
		expect(resolveSettingsProject(projects, "unknown")).toBeNull();
		expect(getSettingsProjectName(null, "raw-project-identity")).toBe("Unknown project");
		expect(getSettingsProjectName(null, null)).toBe("No project selected");
	});

	it("explains project boundaries and immediate action scopes", () => {
		expect(getSettingsScopeDescription("project", "Atlas")).toContain("only to Atlas");
		expect(getSettingsScopeDescription("global", "Atlas")).toContain("all projects");
		expect(getSettingsScopeDescription("desktop", "Atlas")).toContain("save immediately");
		expect(getSettingsScopeDescription("tools", "Atlas")).toContain("immediately");
		expect(getSettingsScopeDescription("tools", "Atlas")).toContain("Each action explains its scope");
		expect(getSettingsScopeDescription("tools", "Atlas")).not.toContain("Runtime-wide");
	});
});
