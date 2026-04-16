import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ConflictResolutionPanel,
	type ConflictResolutionPanelProps,
} from "@/components/git/panels/conflict-resolution-panel";
import type { RuntimeConflictFile, RuntimeConflictState } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("sonner", () => ({
	toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createConflictState(overrides: Partial<RuntimeConflictState> = {}): RuntimeConflictState {
	return {
		operation: "merge",
		sourceBranch: "feature/test",
		currentStep: null,
		totalSteps: null,
		conflictedFiles: ["src/foo.ts", "src/bar.ts"],
		autoMergedFiles: [],
		...overrides,
	};
}

function createConflictFile(path: string): RuntimeConflictFile {
	return {
		path,
		oursContent: `// ours content for ${path}`,
		theirsContent: `// theirs content for ${path}`,
	};
}

function createDefaultProps(overrides: Partial<ConflictResolutionPanelProps> = {}): ConflictResolutionPanelProps {
	return {
		conflictState: createConflictState(),
		conflictFiles: [createConflictFile("src/foo.ts"), createConflictFile("src/bar.ts")],
		resolvedFiles: new Set<string>(),
		autoMergedFiles: [],
		reviewedAutoMergedFiles: new Set<string>(),
		acceptAutoMergedFile: vi.fn(),
		selectedPath: null,
		setSelectedPath: vi.fn(),
		resolveFile: vi.fn(async () => ({ ok: true })),
		continueResolution: vi.fn(async () => ({})),
		abortResolution: vi.fn(async () => ({})),
		isLoading: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConflictResolutionPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderPanel(props: ConflictResolutionPanelProps): void {
		act(() => {
			root.render(<ConflictResolutionPanel {...props} />);
		});
	}

	// -----------------------------------------------------------------------
	// 1. renders merge banner when operation is merge
	// -----------------------------------------------------------------------
	it("renders merge banner when operation is merge", () => {
		renderPanel(createDefaultProps());
		expect(container.textContent).toContain("Merge in progress");
	});

	// -----------------------------------------------------------------------
	// 2. renders rebase banner with step count
	// -----------------------------------------------------------------------
	it("renders rebase banner with step count", () => {
		renderPanel(
			createDefaultProps({
				conflictState: createConflictState({
					operation: "rebase",
					currentStep: 2,
					totalSteps: 5,
				}),
			}),
		);
		expect(container.textContent).toContain("Rebase in progress");
		expect(container.textContent).toContain("commit 2 of 5");
	});

	// -----------------------------------------------------------------------
	// 3. renders file list with conflict status
	// -----------------------------------------------------------------------
	it("renders file list with conflict status", () => {
		renderPanel(createDefaultProps());
		const buttons = Array.from(container.querySelectorAll("button"));
		const fileButtons = buttons.filter(
			(btn) => btn.textContent?.includes("foo.ts") || btn.textContent?.includes("bar.ts"),
		);
		expect(fileButtons.length).toBe(2);
	});

	// -----------------------------------------------------------------------
	// 4. shows ours-vs-theirs diff when file selected
	// -----------------------------------------------------------------------
	it("shows ours-vs-theirs diff when file selected", () => {
		renderPanel(
			createDefaultProps({
				selectedPath: "src/foo.ts",
			}),
		);
		// ReadOnlyUnifiedDiff renders with class kb-diff-readonly
		const diffPanel = container.querySelector(".kb-diff-readonly");
		expect(diffPanel).not.toBeNull();
	});

	// -----------------------------------------------------------------------
	// 5. Accept Ours button calls resolveFile
	// -----------------------------------------------------------------------
	it("Accept Ours button calls resolveFile", () => {
		const resolveFile = vi.fn(async () => ({ ok: true }));
		renderPanel(
			createDefaultProps({
				selectedPath: "src/foo.ts",
				resolveFile,
			}),
		);

		const buttons = Array.from(container.querySelectorAll("button"));
		const acceptOursButton = buttons.find((btn) => btn.textContent?.includes("Accept Ours"));
		expect(acceptOursButton).toBeDefined();

		act(() => {
			acceptOursButton!.click();
		});

		expect(resolveFile).toHaveBeenCalledWith("src/foo.ts", "ours");
	});

	// -----------------------------------------------------------------------
	// 6. Accept Theirs button calls resolveFile
	// -----------------------------------------------------------------------
	it("Accept Theirs button calls resolveFile", () => {
		const resolveFile = vi.fn(async () => ({ ok: true }));
		renderPanel(
			createDefaultProps({
				selectedPath: "src/foo.ts",
				resolveFile,
			}),
		);

		const buttons = Array.from(container.querySelectorAll("button"));
		const acceptTheirsButton = buttons.find((btn) => btn.textContent?.includes("Accept Theirs"));
		expect(acceptTheirsButton).toBeDefined();

		act(() => {
			acceptTheirsButton!.click();
		});

		expect(resolveFile).toHaveBeenCalledWith("src/foo.ts", "theirs");
	});

	// -----------------------------------------------------------------------
	// 7. Complete button disabled when unresolved files exist
	// -----------------------------------------------------------------------
	it("Complete button disabled when unresolved files exist", () => {
		renderPanel(createDefaultProps());

		const buttons = Array.from(container.querySelectorAll("button"));
		const completeButton = buttons.find((btn) => btn.textContent?.includes("Complete"));
		expect(completeButton).toBeDefined();
		expect(completeButton!.disabled).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 8. Complete button enabled when all files resolved
	// -----------------------------------------------------------------------
	it("Complete button enabled when all files resolved", () => {
		renderPanel(
			createDefaultProps({
				conflictState: createConflictState({ conflictedFiles: [] }),
				resolvedFiles: new Set(["src/foo.ts", "src/bar.ts"]),
			}),
		);

		const buttons = Array.from(container.querySelectorAll("button"));
		const completeButton = buttons.find((btn) => btn.textContent?.includes("Complete"));
		expect(completeButton).toBeDefined();
		expect(completeButton!.disabled).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 9. Abort button always enabled
	// -----------------------------------------------------------------------
	it("Abort button always enabled", () => {
		// With unresolved files
		renderPanel(createDefaultProps());

		const buttons = Array.from(container.querySelectorAll("button"));
		const abortButton = buttons.find((btn) => btn.textContent?.includes("Abort"));
		expect(abortButton).toBeDefined();
		expect(abortButton!.disabled).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 10. Complete button enabled when resolved conflicts migrate to auto-merged
	// -----------------------------------------------------------------------
	it("Complete button enabled when resolved conflicts appear in autoMergedFiles", () => {
		// After resolving all conflicts, the next metadata poll re-classifies the
		// resolved files as "auto-merged" (they show up in `git diff --cached`).
		// The Complete button must still be enabled — those files should not need
		// a second review in the auto-merged section.
		renderPanel(
			createDefaultProps({
				conflictState: createConflictState({
					conflictedFiles: [],
					autoMergedFiles: ["src/foo.ts", "src/bar.ts"],
				}),
				resolvedFiles: new Set(["src/foo.ts", "src/bar.ts"]),
				reviewedAutoMergedFiles: new Set<string>(),
			}),
		);

		const buttons = Array.from(container.querySelectorAll("button"));
		const completeButton = buttons.find((btn) => btn.textContent?.includes("Complete"));
		expect(completeButton).toBeDefined();
		expect(completeButton!.disabled).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 11. Resolved conflicts don't appear in auto-merged file list
	// -----------------------------------------------------------------------
	it("resolved conflicts are excluded from auto-merged section", () => {
		renderPanel(
			createDefaultProps({
				conflictState: createConflictState({
					conflictedFiles: [],
					autoMergedFiles: ["src/foo.ts", "src/other.ts"],
				}),
				resolvedFiles: new Set(["src/foo.ts"]),
				reviewedAutoMergedFiles: new Set<string>(),
			}),
		);

		// The auto-merged header should still render (for src/other.ts)
		expect(container.textContent).toContain("Auto-merged");
		// src/foo.ts should only appear once (in the resolved-conflicts section), not twice
		const buttons = Array.from(container.querySelectorAll("button"));
		const fooButtons = buttons.filter((btn) => btn.textContent?.includes("foo.ts"));
		expect(fooButtons.length).toBe(1);
	});

	// -----------------------------------------------------------------------
	// 12. Abort button shows consequence text
	// -----------------------------------------------------------------------
	it("Abort button shows operation name in label", () => {
		// Merge — abort label should say "Abort Merge"
		renderPanel(createDefaultProps());
		let buttons = Array.from(container.querySelectorAll("button"));
		let abortButton = buttons.find((btn) => btn.textContent?.includes("Abort"));
		expect(abortButton).toBeDefined();
		expect(abortButton!.textContent).toContain("Abort Merge");

		// Rebase — abort label should say "Abort Rebase"
		renderPanel(
			createDefaultProps({
				conflictState: createConflictState({ operation: "rebase" }),
			}),
		);
		buttons = Array.from(container.querySelectorAll("button"));
		abortButton = buttons.find((btn) => btn.textContent?.includes("Abort"));
		expect(abortButton).toBeDefined();
		expect(abortButton!.textContent).toContain("Abort Rebase");
	});
});
