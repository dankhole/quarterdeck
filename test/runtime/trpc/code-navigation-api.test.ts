import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageNavigationManager } from "../../../src/language-navigation/manager";
import { createCodeNavigationApi } from "../../../src/trpc/code-navigation-api";
import { resolveProjectFileScope } from "../../../src/trpc/project-api-file-scopes";
import { createDefaultMockConfig } from "../../utilities/runtime-config-factory";

vi.mock("../../../src/trpc/project-api-file-scopes", () => ({ resolveProjectFileScope: vi.fn() }));

describe("code navigation API scope ownership", () => {
	const manager = new LanguageNavigationManager();
	afterEach(() => vi.resetAllMocks());
	const scope = { projectId: "synthetic", projectPath: "/synthetic" };
	const input = { path: "file.ts", documentVersion: 1, content: "target", position: { line: 0, character: 0 } };

	it("rejects historical refs before config or language-server work", async () => {
		vi.mocked(resolveProjectFileScope).mockResolvedValue({ cwd: "/synthetic", ref: "HEAD~1", mutable: false });
		const loadScopedRuntimeConfig = vi.fn();
		const api = createCodeNavigationApi(manager, { loadScopedRuntimeConfig });
		expect(await api.definition(scope, { ...input, ref: "HEAD~1" })).toMatchObject({ status: "unavailable" });
		expect(loadScopedRuntimeConfig).not.toHaveBeenCalled();
		expect(manager.getSnapshot().processCount).toBe(0);
	});

	it("captures admission before asynchronous scope/config lookup so removed projects cannot restart", async () => {
		vi.mocked(resolveProjectFileScope).mockResolvedValue({ cwd: "/synthetic", ref: null, mutable: true });
		let release = (_value: ReturnType<typeof createDefaultMockConfig>) => {};
		const deferred = new Promise<ReturnType<typeof createDefaultMockConfig>>((resolve) => {
			release = resolve;
		});
		const loadScopedRuntimeConfig = vi.fn(() => deferred);
		const api = createCodeNavigationApi(manager, { loadScopedRuntimeConfig });
		const response = api.definition(scope, input);
		await vi.waitFor(() => expect(loadScopedRuntimeConfig).toHaveBeenCalled());
		await manager.stopProject(scope.projectId);
		release(createDefaultMockConfig({ codeNavigationEnabled: true }));
		expect(await response).toMatchObject({ status: "error", message: expect.stringContaining("scope changed") });
		expect(manager.getSnapshot().processCount).toBe(0);
		await manager.close();
	});
});
