import { describe, expect, it, vi } from "vitest";

import { createRuntimeHostIntegrations } from "../../src/server/runtime-host-integrations";

describe("runtime host integrations", () => {
	it("fails closed before invoking any launcher when native UI is disabled", async () => {
		const pickDirectory = vi.fn(async () => {
			throw new Error("forbidden picker invoked");
		});
		const openTarget = vi.fn(async () => {
			throw new Error("forbidden external launcher invoked");
		});
		const openProject = vi.fn(async () => {
			throw new Error("forbidden IDE launcher invoked");
		});
		const onAttempt = vi.fn();
		const warn = vi.fn();
		const integrations = createRuntimeHostIntegrations({
			capabilities: { nativeUiAvailable: false, hostIntegrationMode: "unavailable" },
			pickDirectory,
			openTarget,
			openProject,
			onAttempt,
			warn,
		});

		await expect(integrations.pickDirectory()).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
		await expect(integrations.openPath("/tmp/project")).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
		await expect(integrations.openExternalUrl("https://example.com")).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
		await expect(integrations.openProject("vscode", "/tmp/project")).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});

		expect(pickDirectory).not.toHaveBeenCalled();
		expect(openTarget).not.toHaveBeenCalled();
		expect(openProject).not.toHaveBeenCalled();
		expect(onAttempt.mock.calls.map(([attempt]) => attempt)).toEqual([
			{ kind: "directory_picker", blocked: true, mode: "unavailable" },
			{ kind: "open_path", blocked: true, mode: "unavailable" },
			{ kind: "external_url", blocked: true, mode: "unavailable" },
			{ kind: "open_project", blocked: true, mode: "unavailable" },
		]);
		expect(warn).toHaveBeenCalledTimes(4);
	});

	it("preserves normal native integrations when the capability is enabled", async () => {
		const pickDirectory = vi.fn(async () => ({ kind: "selected" as const, path: "/tmp/project" }));
		const openTarget = vi.fn(async () => {});
		const openProject = vi.fn(async () => ({ kind: "opened" as const }));
		const integrations = createRuntimeHostIntegrations({
			capabilities: { nativeUiAvailable: true, hostIntegrationMode: "native" },
			pickDirectory,
			openTarget,
			openProject,
		});

		await expect(integrations.pickDirectory()).resolves.toEqual({
			ok: true,
			path: "/tmp/project",
			outcome: "native",
		});
		await expect(integrations.openPath("/tmp/project/file.txt")).resolves.toEqual({
			ok: true,
			outcome: "native",
		});
		await expect(integrations.openExternalUrl("https://example.com")).resolves.toEqual({
			ok: true,
			outcome: "native",
		});
		await expect(integrations.openProject("vscode", "/tmp/project")).resolves.toEqual({
			ok: true,
			outcome: "native",
		});
		expect(openTarget).toHaveBeenNthCalledWith(1, "/tmp/project/file.txt");
		expect(openTarget).toHaveBeenNthCalledWith(2, "https://example.com");
		expect(openProject).toHaveBeenCalledWith("vscode", "/tmp/project");
	});

	it("routes simulated success through the injected policy without reaching native launchers", async () => {
		const pickDirectory = vi.fn(async () => {
			throw new Error("native picker invoked");
		});
		const openTarget = vi.fn(async () => {
			throw new Error("native path or URL opener invoked");
		});
		const openProject = vi.fn(async () => {
			throw new Error("native IDE launcher invoked");
		});
		const simulator = {
			recordUnsupportedDirectoryPicker: vi.fn(async () => {}),
			openPath: vi.fn(async () => ({ ok: true as const })),
			openExternalUrl: vi.fn(async () => ({ ok: true as const })),
			openProject: vi.fn(async () => ({ ok: true as const })),
		};
		const onAttempt = vi.fn();
		const integrations = createRuntimeHostIntegrations({
			capabilities: { nativeUiAvailable: false, hostIntegrationMode: "simulated" },
			pickDirectory,
			openTarget,
			openProject,
			simulator,
			onAttempt,
		});

		await expect(integrations.pickDirectory()).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
		await expect(integrations.openPath("/tmp/project/file.txt", { projectId: "project-1" })).resolves.toEqual({
			ok: true,
			outcome: "simulated",
		});
		await expect(integrations.openExternalUrl("https://example.com/path?token=hidden")).resolves.toEqual({
			ok: true,
			outcome: "simulated",
		});
		await expect(integrations.openProject("cursor", "/tmp/project", { projectId: "project-1" })).resolves.toEqual({
			ok: true,
			outcome: "simulated",
		});

		expect(pickDirectory).not.toHaveBeenCalled();
		expect(openTarget).not.toHaveBeenCalled();
		expect(openProject).not.toHaveBeenCalled();
		expect(simulator.openPath).toHaveBeenCalledWith("/tmp/project/file.txt", { projectId: "project-1" });
		expect(simulator.openProject).toHaveBeenCalledWith("cursor", "/tmp/project", {
			projectId: "project-1",
		});
		expect(onAttempt.mock.calls.map(([attempt]) => attempt)).toEqual([
			{ kind: "directory_picker", blocked: false, mode: "simulated" },
			{ kind: "open_path", blocked: false, mode: "simulated" },
			{ kind: "external_url", blocked: false, mode: "simulated" },
			{ kind: "open_project", blocked: false, mode: "simulated" },
		]);
	});

	it("returns typed failures when simulated evidence recording fails", async () => {
		const simulatorError = new Error("host ledger unavailable");
		const warn = vi.fn();
		const integrations = createRuntimeHostIntegrations({
			capabilities: { nativeUiAvailable: false, hostIntegrationMode: "simulated" },
			warn,
			simulator: {
				recordUnsupportedDirectoryPicker: vi.fn(async () => {
					throw simulatorError;
				}),
				openPath: vi.fn(async () => {
					throw simulatorError;
				}),
				openExternalUrl: vi.fn(async () => {
					throw simulatorError;
				}),
				openProject: vi.fn(async () => {
					throw simulatorError;
				}),
			},
			pickDirectory: vi.fn(async () => {
				throw new Error("native picker invoked");
			}),
			openTarget: vi.fn(async () => {
				throw new Error("native opener invoked");
			}),
			openProject: vi.fn(async () => {
				throw new Error("native IDE invoked");
			}),
		});

		await expect(integrations.pickDirectory()).resolves.toMatchObject({
			ok: false,
			reason: "launch_failed",
			error: "host ledger unavailable",
		});
		await expect(integrations.openPath("/tmp/project")).resolves.toMatchObject({
			ok: false,
			reason: "launch_failed",
		});
		await expect(integrations.openExternalUrl("https://example.com")).resolves.toMatchObject({
			ok: false,
			reason: "launch_failed",
		});
		await expect(integrations.openProject("vscode", "/tmp/project")).resolves.toMatchObject({
			ok: false,
			reason: "launch_failed",
		});
		expect(warn).toHaveBeenCalledTimes(4);
	});

	it("reports launcher absence separately from launch failures", async () => {
		const unavailableError = Object.assign(new Error("opener missing"), { code: "ENOENT" });
		const integrations = createRuntimeHostIntegrations({
			capabilities: { nativeUiAvailable: true, hostIntegrationMode: "native" },
			pickDirectory: vi.fn(async () => ({ kind: "unavailable" as const, error: "picker missing" })),
			openTarget: vi
				.fn<(target: string) => Promise<void>>()
				.mockRejectedValueOnce(unavailableError)
				.mockRejectedValueOnce(new Error("open failed")),
			openProject: vi.fn(async () => ({ kind: "unavailable" as const, error: "IDE missing" })),
		});

		await expect(integrations.pickDirectory()).resolves.toEqual({
			ok: false,
			path: null,
			reason: "launcher_unavailable",
			error: "picker missing",
		});
		await expect(integrations.openPath("/tmp/project")).resolves.toEqual({
			ok: false,
			reason: "launcher_unavailable",
			error: "opener missing",
		});
		await expect(integrations.openExternalUrl("https://example.com")).resolves.toEqual({
			ok: false,
			reason: "launch_failed",
			error: "open failed",
		});
		await expect(integrations.openProject("vscode", "/tmp/project")).resolves.toEqual({
			ok: false,
			reason: "launcher_unavailable",
			error: "IDE missing",
		});
	});
});
