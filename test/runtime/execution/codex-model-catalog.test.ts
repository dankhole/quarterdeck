import { describe, expect, it, vi } from "vitest";
import { loadCodexModelCatalog } from "../../../src/config/codex-model-catalog";
import type { OwnedCodexAppServerTransport } from "../../../src/execution/codex-app-server-client";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

function model(model: string, hidden = false) {
	return {
		id: model,
		model,
		displayName: model,
		hidden,
		isDefault: false,
		defaultReasoningEffort: "future-level",
		supportedReasoningEfforts: [{ reasoningEffort: "future-level", description: "Provider-defined effort" }],
	};
}

function fixture(pages: unknown[]) {
	const messages = new Set<(message: unknown) => void>();
	const methods: string[] = [];
	const stop = vi.fn();
	const transport: OwnedCodexAppServerTransport = {
		pid: 123,
		write(message) {
			const request = message as { id?: number; method: string };
			methods.push(request.method);
			if (request.id === undefined) return;
			queueMicrotask(() => {
				const result =
					request.method === "initialize"
						? { userAgent: "fake", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "linux" }
						: pages.shift();
				for (const listener of messages) listener({ id: request.id, result });
			});
		},
		onMessage(listener) {
			messages.add(listener);
			return () => messages.delete(listener);
		},
		onExit: () => () => {},
		requestStop: vi.fn(),
		stopAndReap: async () => {
			stop();
		},
		waitForExit: async () => true,
	};
	const resolveCommand = vi.fn(async () => ({
		agentId: "codex" as const,
		label: "Codex",
		command: "codex",
		binary: "codex",
		args: [],
	}));
	const spawnTransport = vi.fn(() => transport);
	return { methods, stop, dependencies: { resolveCommand, spawnTransport } };
}

describe("Codex model catalog", () => {
	it("lists all visible pages and keeps provider-specific effort metadata without starting a conversation", async () => {
		const f = fixture([
			{ data: [model("first"), model("hidden", true)], nextCursor: "page-two" },
			{ data: [model("second")] },
		]);
		const result = await loadCodexModelCatalog(createTestRuntimeConfigState(), "/tmp/project", f.dependencies);
		expect(result.models.map((entry) => entry.model)).toEqual(["first", "second"]);
		expect(result.models[0]?.supportedReasoningEfforts[0]?.reasoningEffort).toBe("future-level");
		expect(f.methods).toEqual(["initialize", "initialized", "model/list", "model/list"]);
		expect(f.stop).toHaveBeenCalledOnce();
		expect(f.dependencies.resolveCommand).toHaveBeenCalledWith(expect.objectContaining({ selectedAgentId: "codex" }));
		expect(f.dependencies.spawnTransport).toHaveBeenCalledWith(
			expect.objectContaining({ binary: "codex", args: ["app-server", "--stdio"], cwd: "/tmp/project" }),
		);
	});

	it("stops discovery when the provider returns malformed metadata", async () => {
		const f = fixture([{ data: [{ ...model("invalid"), supportedReasoningEfforts: [{ reasoningEffort: "" }] }] }]);
		await expect(
			loadCodexModelCatalog(createTestRuntimeConfigState(), "/tmp/project", f.dependencies),
		).rejects.toThrow();
		expect(f.stop).toHaveBeenCalledOnce();
	});

	it("rejects repeated pagination cursors and stops the process", async () => {
		const f = fixture([
			{ data: [], nextCursor: "repeat" },
			{ data: [], nextCursor: "repeat" },
		]);
		await expect(
			loadCodexModelCatalog(createTestRuntimeConfigState(), "/tmp/project", f.dependencies),
		).rejects.toThrow("repeated");
		expect(f.stop).toHaveBeenCalledOnce();
	});
});
