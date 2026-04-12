import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import type { RuntimeProjectSummary } from "@/runtime/types";

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

const PROJECTS: RuntimeProjectSummary[] = [
	{
		id: "project-1",
		name: "Quarterdeck",
		path: "/tmp/quarterdeck",
		taskCounts: {
			backlog: 0,
			in_progress: 0,
			review: 0,
			trash: 0,
		},
	},
];

describe("ProjectNavigationPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let previousAppVersion: unknown;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		previousAppVersion = (globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__;
		(globalThis as typeof globalThis & { __APP_VERSION__?: string }).__APP_VERSION__ = "test";
		localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		localStorage.clear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		if (typeof previousAppVersion === "undefined") {
			delete (globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__;
		} else {
			(globalThis as typeof globalThis & { __APP_VERSION__?: unknown }).__APP_VERSION__ = previousAppVersion;
		}
	});

	function renderPanel(overrides: Partial<ComponentProps<typeof ProjectNavigationPanel>> = {}): void {
		act(() => {
			root.render(
				<ProjectNavigationPanel
					projects={PROJECTS}
					currentProjectId="project-1"
					removingProjectId={null}
					activeSection="projects"
					onActiveSectionChange={() => {}}
					canShowAgentSection
					onSelectProject={() => {}}
					onRemoveProject={async () => true}
					onAddProject={() => {}}
					notificationSessions={{}}
					notificationWorkspaceIds={{}}
					{...overrides}
				/>,
			);
		});
	}

	it("renders the project list", () => {
		renderPanel();
		const projectRow = container.querySelector(".kb-project-row");
		expect(projectRow).toBeInstanceOf(HTMLElement);
		expect(projectRow?.textContent).toContain("Quarterdeck");
	});

	it("fills its parent container without fixed width", () => {
		renderPanel();
		// The root element should be a flex column div, not a fixed-width aside
		const rootEl = container.firstElementChild;
		expect(rootEl).toBeInstanceOf(HTMLElement);
		expect(rootEl?.tagName).toBe("DIV");
		// No inline width style — fills parent via flex-1
		expect((rootEl as HTMLElement).style.width).toBe("");
	});

	it("renders the add project button", () => {
		renderPanel();
		const addButton = Array.from(container.querySelectorAll("button")).find(
			(btn) => btn.textContent?.trim() === "Add Project",
		);
		expect(addButton).toBeInstanceOf(HTMLButtonElement);
	});

	it("renders the beta notice with report issue link", () => {
		renderPanel();
		expect(container.textContent).toContain("Quarterdeck is in beta");
		const link = container.querySelector('a[href*="github.com"]');
		expect(link).toBeInstanceOf(HTMLAnchorElement);
		expect(link?.textContent).toContain("Report issue");
		expect(link?.getAttribute("target")).toBe("_blank");
	});
});
