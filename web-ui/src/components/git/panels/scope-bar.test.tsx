import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScopeBar } from "@/components/git/panels/scope-bar";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("ScopeBar base comparisons", () => {
	it.each([false, true])("shows both counts for detached=%s task worktrees", (isDetached) => {
		const markup = renderToStaticMarkup(
			<TooltipProvider>
				<ScopeBar
					resolvedScope={{
						type: "task",
						projectId: "project",
						taskId: "task",
						baseRef: "main",
						branch: isDetached ? null : "feature",
					}}
					scopeMode="contextual"
					homeGitSummary={null}
					taskTitle="Task title"
					taskBranch={isDetached ? null : "feature"}
					taskBaseRef="main"
					behindBaseCount={0}
					behindRemoteBaseCount={2}
					isDetachedHead={false}
					taskIsDetached={isDetached}
					branchPillSlot={isDetached ? <span>deadbeef</span> : undefined}
					onSwitchToHome={() => {}}
					onReturnToContextual={() => {}}
				/>
			</TooltipProvider>,
		);
		expect(markup).toContain("0 behind local · 2 behind remote");
		expect(markup).toContain("text-status-blue");
	});
});
