import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BranchSelectorPopover } from "@/components/git/panels/branch-selector-popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeGitRef } from "@/runtime/types";

function createDetachedRef(): RuntimeGitRef {
	return {
		name: "deadbee",
		type: "detached",
		hash: "deadbeef12345678",
		isHead: true,
	};
}

describe("BranchSelectorPopover", () => {
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
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("explains detached task worktrees in the branch dropdown", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BranchSelectorPopover
						isOpen
						onOpenChange={() => {}}
						branches={[createDetachedRef()]}
						currentBranch={null}
						worktreeBranches={new Map()}
						onSelectBranchView={() => {}}
						detachedWorktreeBaseRef="main"
						detachedWorktreeHeadCommit="deadbeef12345678"
						trigger={<button type="button">Branch</button>}
					/>
				</TooltipProvider>,
			);
		});

		expect(document.body.textContent).toContain("HEAD (deadbee)");
		expect(document.body.textContent).toContain("detached from main");
		expect(document.body.textContent).toContain("Independent task worktree.");
	});
});
