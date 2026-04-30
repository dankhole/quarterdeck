import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { UseCommitPanelResult } from "@/hooks/git/use-commit-panel";
import type { RuntimeWorkdirFileChange } from "@/runtime/types";

const useCommitPanelMock = vi.hoisted(() => vi.fn<() => UseCommitPanelResult>());

vi.mock("@/hooks/git/use-commit-panel", () => ({
	useCommitPanel: useCommitPanelMock,
}));

vi.mock("@/stores/project-metadata-store", () => ({
	useHomeStashCount: () => 0,
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

vi.mock("./stash-list-section", () => ({
	StashListSection: () => <div data-testid="stash-list" />,
}));

import { CommitPanel } from "@/components/git/panels/commit-panel";

const files: RuntimeWorkdirFileChange[] = [
	{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1, oldText: null, newText: null },
];

function createCommitPanelResult(overrides: Partial<UseCommitPanelResult> = {}): UseCommitPanelResult {
	return {
		files,
		selectedPaths: ["src/a.ts"],
		isAllSelected: true,
		isIndeterminate: false,
		toggleFile: vi.fn(),
		toggleAll: vi.fn(),
		message: "",
		setMessage: vi.fn(),
		canCommit: false,
		canPush: false,
		isLoading: false,
		isCommitting: false,
		isPushing: false,
		isDiscarding: false,
		isRollingBack: false,
		isStashing: false,
		isGeneratingMessage: false,
		generateMessage: vi.fn(async () => {}),
		stashMessage: "",
		setStashMessage: vi.fn(),
		stashChanges: vi.fn(async () => {}),
		lastError: null,
		clearError: vi.fn(),
		commitFiles: vi.fn(async () => {}),
		commitAndPush: vi.fn(async () => {}),
		discardAll: vi.fn(async () => {}),
		rollbackFile: vi.fn(async () => {}),
		...overrides,
	};
}

function createRect(height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		width: 320,
		height,
		top: 0,
		right: 320,
		bottom: height,
		left: 0,
		toJSON: () => ({}),
	};
}

function requireElement(container: HTMLElement, selector: string): HTMLElement {
	const element = container.querySelector(selector);
	if (!(element instanceof HTMLElement)) {
		throw new Error(`Expected element for selector ${selector}.`);
	}
	return element;
}

describe("CommitPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.localStorage.clear();
		useCommitPanelMock.mockReturnValue(createCommitPanelResult());
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		window.localStorage.clear();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function render(): void {
		act(() => {
			root.render(
				<TooltipProvider>
					<CommitPanel projectId="project-1" taskId={null} baseRef="main" />
				</TooltipProvider>,
			);
		});
	}

	it("uses a top divider resize handle instead of native textarea resizing", () => {
		render();

		const separator = requireElement(container, '[aria-label="Resize commit controls"]');
		const textarea = requireElement(container, 'textarea[name="commit-message"]');
		const grip = Array.from(separator.children).find(
			(child): child is HTMLElement => child instanceof HTMLElement && child.className.includes("items-center"),
		);
		if (!(grip instanceof HTMLElement)) {
			throw new Error("Expected a visible resize grip.");
		}

		expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
		expect(grip.className).toContain("left-1/2");
		expect(grip.className).toContain("-translate-x-1/2");
		expect(textarea.className).toContain("resize-none");
		expect(textarea.className).not.toContain("resize-y");
	});

	it("resizes the commit controls by dragging the divider line", () => {
		render();

		const separator = requireElement(container, '[aria-label="Resize commit controls"]');
		const changesList = separator.previousElementSibling;
		const commitControls = separator.nextElementSibling;
		if (!(changesList instanceof HTMLElement) || !(commitControls instanceof HTMLElement)) {
			throw new Error("Expected the resize separator between the changes list and commit controls.");
		}

		vi.spyOn(changesList, "getBoundingClientRect").mockReturnValue(createRect(300));
		vi.spyOn(commitControls, "getBoundingClientRect").mockReturnValue(createRect(196));

		act(() => {
			separator.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 220 }));
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 120 }));
		});

		expect(commitControls.style.height).toBe("296px");

		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 120 }));
		});
	});
});
