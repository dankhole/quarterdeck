import Prism from "prismjs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnifiedDiff } from "@/components/git/panels/diff-unified";

function buildLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
}

describe("UnifiedDiff", () => {
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

	it("highlights rendered rows without pre-highlighting the full old and new files", async () => {
		const before = buildLines("const before =", 80);
		const after = buildLines("const after =", 80);
		const oldText = [...before, "const value = 1;", ...after].join("\n");
		const newText = [...before, "const value = 2;", ...after].join("\n");
		const highlightSpy = vi.spyOn(Prism, "highlight");

		await act(async () => {
			root.render(
				<UnifiedDiff
					path="src/example.ts"
					oldText={oldText}
					newText={newText}
					comments={new Map()}
					onAddComment={() => {}}
					onUpdateComment={() => {}}
					onDeleteComment={() => {}}
				/>,
			);
		});

		expect(container.querySelectorAll(".kb-diff-row")).toHaveLength(8);
		expect(container.textContent).toContain("Show");
		expect(highlightSpy.mock.calls.length).toBeGreaterThan(0);
		expect(highlightSpy.mock.calls.length).toBeLessThan(40);
	});
});
