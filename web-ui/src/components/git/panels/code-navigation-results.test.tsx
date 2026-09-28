import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CodeNavigationResults } from "./code-navigation-results";

describe("CodeNavigationResults", () => {
	it("keeps grouped paths and passes the complete range to Files navigation", async () => {
		const prior = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		const root = createRoot(container);
		const onNavigate = vi.fn();
		const location = {
			path: "src/target.ts",
			range: { start: { line: 8, character: 4 }, end: { line: 8, character: 12 } },
		};
		try {
			await act(async () => {
				root.render(
					<CodeNavigationResults
						result={{
							status: "locations",
							operation: "definition",
							sourcePath: "src/original.ts",
							locations: [location],
							truncated: false,
						}}
						onDismiss={() => {}}
						onNavigate={onNavigate}
					/>,
				);
			});
			expect(container.textContent).toContain("src/target.ts");
			const button = Array.from(container.querySelectorAll("button")).find((item) =>
				item.textContent?.includes("Line 9, column 5"),
			);
			await act(async () => button?.click());
			expect(onNavigate).toHaveBeenCalledWith(location);
		} finally {
			act(() => root.unmount());
			(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prior;
		}
	});
});
