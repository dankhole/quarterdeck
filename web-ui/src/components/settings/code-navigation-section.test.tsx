import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInitialValues } from "@/hooks/settings/settings-form";
import type { LspServerConfig } from "@/runtime/types";
import { CodeNavigationSection } from "./code-navigation-section";

const check = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { checkLspCommand: { query: check } } }),
}));
const server: LspServerConfig = {
	id: "test",
	label: "Test",
	enabled: true,
	command: "server",
	args: [],
	extensions: [".ts"],
	rootMarkers: [],
	env: { PATH: "/old/bin" },
};

describe("language-server command availability settings", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		check.mockReset();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	function render(servers: LspServerConfig[]) {
		act(() =>
			root.render(
				<CodeNavigationSection
					fields={{ ...resolveInitialValues(null), lspServers: servers }}
					setField={vi.fn()}
					disabled={false}
					projectId="project"
				/>,
			),
		);
	}
	function buttons() {
		return Array.from(container.querySelectorAll("button")).filter(
			(button) => button.textContent === "Check command",
		);
	}
	it("passes the server environment and keeps distinct results for the same command", async () => {
		check
			.mockResolvedValueOnce({ available: true, message: "Found in old PATH" })
			.mockResolvedValueOnce({ available: false, message: "Missing in new PATH" });
		const second = { ...server, id: "second", env: { PATH: "/new/bin" } };
		render([server, second]);
		await act(async () => buttons()[0]?.click());
		expect(check).toHaveBeenLastCalledWith({ command: "server", env: server.env });
		expect(container.querySelectorAll('[role="status"]')[1]?.textContent).toBe(
			"Command availability has not been checked.",
		);
		await act(async () => buttons()[1]?.click());
		expect(check).toHaveBeenLastCalledWith({ command: "server", env: second.env });
		expect(container.textContent).toContain("Found in old PATH");
		expect(container.textContent).toContain("Missing in new PATH");
	});
	it("does not display an old in-flight result after environment editing", async () => {
		let resolve!: (value: { available: boolean; message: string }) => void;
		check.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		render([server]);
		await act(async () => buttons()[0]?.click());
		expect(buttons()[0]?.disabled).toBe(true);
		render([{ ...server, env: { PATH: "/new/bin" } }]);
		expect(buttons()[0]?.disabled).toBe(false);
		expect(container.textContent).toContain("Command availability has not been checked.");
		await act(async () => resolve({ available: true, message: "Old PATH result" }));
		expect(container.textContent).not.toContain("Old PATH result");
	});
});
