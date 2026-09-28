import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig, type RuntimeConfigState, updateRuntimeConfig } from "../../src/config";
import { lockedFileSystem } from "../../src/fs";
import { handleSaveConfig } from "../../src/trpc/handlers/save-config";
import { createDefaultRuntimeConfigSaveRequest } from "../utilities/runtime-config-factory";
import { withTemporaryHome } from "../utilities/temp-dir";

const registry = vi.hoisted(() => ({
	buildRuntimeConfigResponse: vi.fn(async (config: unknown) => config),
	getAgentAvailability: vi.fn(async () => ({ installed: true })),
	detectRunnableAgentIds: vi.fn(async () => []),
}));
vi.mock("../../src/config/agent-registry", () => registry);

async function createDeps() {
	const config = await loadRuntimeConfig(null);
	await mkdir(dirname(config.globalConfigPath), { recursive: true });
	await writeFile(config.globalConfigPath, "{}\n");
	return {
		config: {
			getActiveRuntimeConfig: () => config,
			loadScopedRuntimeConfig: async () => config,
			setActiveRuntimeConfig: vi.fn((_config: RuntimeConfigState) => {}),
		},
		getActiveProjectId: (): string | null => "project-1",
		broadcaster: { broadcastLogLevel: vi.fn() },
		runtimeCapabilities: { nativeUiAvailable: false, hostIntegrationMode: "unavailable" } as const,
		onCodeNavigationConfigChanged: vi.fn(async () => {}),
	};
}

async function createActiveProjectDeps() {
	const deps = await createDeps();
	let activeProjectId: string | null = "project-1";
	let activeConfig = await loadRuntimeConfig(activeProjectId);
	deps.getActiveProjectId = () => activeProjectId;
	deps.config.getActiveRuntimeConfig = () => activeConfig;
	deps.config.setActiveRuntimeConfig.mockImplementation((config) => {
		activeConfig = config;
	});
	return {
		...deps,
		selectProject: async (projectId: string | null) => {
			activeProjectId = projectId;
			activeConfig = await loadRuntimeConfig(projectId);
		},
	};
}

function pauseNextConfigWrite(path: string) {
	const originalWrite = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
	let releaseWrite = () => {};
	let markWritePaused = () => {};
	const released = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	const paused = new Promise<void>((resolve) => {
		markWritePaused = resolve;
	});
	let pausePending = true;
	vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (target, payload, options) => {
		if (target === path && pausePending) {
			pausePending = false;
			markWritePaused();
			await released;
		}
		await originalWrite(target, payload, options);
	});
	return { paused, releaseWrite };
}

describe("configuration saves and language-server lifetime", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		registry.buildRuntimeConfigResponse.mockReset().mockImplementation(async (config: unknown) => config);
	});

	it("keeps sessions for a complete unchanged Settings submission and unrelated changes", async () => {
		await withTemporaryHome(async () => {
			const deps = await createDeps();
			const fields = createDefaultRuntimeConfigSaveRequest();
			await handleSaveConfig(null, structuredClone(fields), deps);
			await handleSaveConfig(null, { ...structuredClone(fields), terminalFontWeight: 450 }, deps);
			expect(deps.onCodeNavigationConfigChanged).not.toHaveBeenCalled();
			expect((await loadRuntimeConfig(null)).terminalFontWeight).toBe(450);
		});
	});

	it("resets for effective enabled or server changes in either save scope", async () => {
		await withTemporaryHome(async () => {
			const deps = await createDeps();
			await handleSaveConfig(null, { codeNavigationEnabled: true }, deps);
			const scope = { projectId: "project-1", projectPath: "/synthetic/project" };
			const lspServers = structuredClone((await loadRuntimeConfig(null)).lspServers);
			const server = lspServers[0];
			if (!server) throw new Error("Expected the default language server");
			server.args.push("--example-option");
			await handleSaveConfig(scope, { lspServers }, deps);
			await handleSaveConfig(scope, { lspServers: structuredClone(lspServers) }, deps);
			expect(deps.onCodeNavigationConfigChanged).toHaveBeenCalledTimes(2);
		});
	});

	it("observes opposing overlapping saves against persisted state rather than the cached active state", async () => {
		await withTemporaryHome(async () => {
			const deps = await createDeps();
			let releaseFirstResponse = () => {};
			let markFirstPersisted = () => {};
			const firstResponse = new Promise<void>((resolve) => {
				releaseFirstResponse = resolve;
			});
			const firstPersisted = new Promise<void>((resolve) => {
				markFirstPersisted = resolve;
			});
			registry.buildRuntimeConfigResponse.mockImplementationOnce(async (config: unknown) => {
				markFirstPersisted();
				await firstResponse;
				return config;
			});
			const enabling = handleSaveConfig(null, { codeNavigationEnabled: true }, deps);
			await firstPersisted;
			try {
				// The provider deliberately still returns the original false value.
				await handleSaveConfig(null, { codeNavigationEnabled: false }, deps);
			} finally {
				releaseFirstResponse();
				await enabling;
			}
			expect((await loadRuntimeConfig(null)).codeNavigationEnabled).toBe(false);
			expect(deps.onCodeNavigationConfigChanged).toHaveBeenCalledTimes(2);
		});
	});

	it("retains current global changes and caller project fields when saving from stale active state", async () => {
		await withTemporaryHome(async () => {
			const deps = await createDeps();
			const projectFields: Pick<
				RuntimeConfigState,
				"projectConfigPath" | "shortcuts" | "pinnedBranches" | "defaultBaseRef" | "worktreeSetupScript"
			> = {
				projectConfigPath: "/synthetic/project-config.json",
				shortcuts: [{ label: "Build", command: "npm run build" }],
				pinnedBranches: ["main"],
				defaultBaseRef: "main",
				worktreeSetupScript: "npm ci",
			};
			Object.assign(deps.config.getActiveRuntimeConfig(), projectFields);
			await handleSaveConfig(null, { codeNavigationEnabled: true }, deps);
			await handleSaveConfig(null, { terminalFontWeight: 450 }, deps);
			const saved = deps.config.setActiveRuntimeConfig.mock.lastCall?.[0];
			expect(saved).toMatchObject({ ...projectFields, codeNavigationEnabled: true, terminalFontWeight: 450 });
			expect((await loadRuntimeConfig(null)).codeNavigationEnabled).toBe(true);
			expect(deps.onCodeNavigationConfigChanged).toHaveBeenCalledTimes(1);
		});
	});

	it("does not reset on validation or persistence failures", async () => {
		await withTemporaryHome(async () => {
			const deps = await createDeps();
			await expect(handleSaveConfig(null, { codeNavigationEnabled: "invalid" }, deps)).rejects.toThrow();
			vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockRejectedValueOnce(new Error("save failed"));
			await expect(handleSaveConfig(null, { codeNavigationEnabled: true }, deps)).rejects.toThrow("save failed");
			expect(deps.onCodeNavigationConfigChanged).not.toHaveBeenCalled();
		});
	});

	it("retains project fields saved while a global save waits for the persistence lock", async () => {
		await withTemporaryHome(async () => {
			const deps = await createActiveProjectDeps();
			const projectFields = {
				shortcuts: [{ label: "Build", command: "npm run build" }],
				pinnedBranches: ["feature"],
				defaultBaseRef: "feature",
				worktreeSetupScript: "npm ci",
			};
			const projectConfigPath = deps.config.getActiveRuntimeConfig().projectConfigPath;
			if (!projectConfigPath) throw new Error("Expected active project config path");
			const gate = pauseNextConfigWrite(projectConfigPath);
			const projectSave = handleSaveConfig(
				{ projectId: "project-1", projectPath: "/synthetic/project" },
				projectFields,
				deps,
			);
			await gate.paused;
			const globalSave = handleSaveConfig(null, { terminalFontWeight: 450 }, deps);
			gate.releaseWrite();
			await Promise.all([projectSave, globalSave]);
			expect(deps.config.getActiveRuntimeConfig()).toMatchObject({ ...projectFields, terminalFontWeight: 450 });
			expect(await loadRuntimeConfig("project-1")).toMatchObject({ ...projectFields, terminalFontWeight: 450 });
		});
	});

	it.each(["project-2", null])(
		"publishes global changes with the current project after switching to %s",
		async (projectId) => {
			await withTemporaryHome(async () => {
				const deps = await createActiveProjectDeps();
				await updateRuntimeConfig("project-2", {
					shortcuts: [{ label: "Test", command: "npm test" }],
					pinnedBranches: ["develop"],
					defaultBaseRef: "develop",
					worktreeSetupScript: "npm install",
				});
				const gate = pauseNextConfigWrite(deps.config.getActiveRuntimeConfig().globalConfigPath);
				const globalSave = handleSaveConfig(null, { terminalFontWeight: 450 }, deps);
				await gate.paused;
				try {
					await deps.selectProject(projectId);
				} finally {
					gate.releaseWrite();
					await globalSave;
				}
				expect(deps.getActiveProjectId()).toBe(projectId);
				expect(deps.config.getActiveRuntimeConfig()).toEqual(await loadRuntimeConfig(projectId));
				expect(deps.config.getActiveRuntimeConfig().terminalFontWeight).toBe(450);
			});
		},
	);

	it.each(["broadcast", "response"])(
		"resets a committed change before a %s failure and leaves an unchanged retry alone",
		async (failure) => {
			await withTemporaryHome(async () => {
				const deps = await createDeps();
				if (failure === "broadcast") {
					deps.broadcaster.broadcastLogLevel.mockImplementationOnce(() => {
						throw new Error("broadcast failed");
					});
				} else {
					registry.buildRuntimeConfigResponse.mockRejectedValueOnce(new Error("response failed"));
				}
				await expect(handleSaveConfig(null, { codeNavigationEnabled: true }, deps)).rejects.toThrow(
					`${failure} failed`,
				);
				expect((await loadRuntimeConfig(null)).codeNavigationEnabled).toBe(true);
				expect(deps.onCodeNavigationConfigChanged).toHaveBeenCalledTimes(1);
				await handleSaveConfig(null, { codeNavigationEnabled: true }, deps);
				expect(deps.onCodeNavigationConfigChanged).toHaveBeenCalledTimes(1);
			});
		},
	);
});
