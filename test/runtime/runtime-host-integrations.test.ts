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
			capabilities: { nativeUiAvailable: false },
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
			{ kind: "directory_picker", blocked: true },
			{ kind: "open_path", blocked: true },
			{ kind: "external_url", blocked: true },
			{ kind: "open_project", blocked: true },
		]);
		expect(warn).toHaveBeenCalledTimes(4);
	});

	it("preserves normal native integrations when the capability is enabled", async () => {
		const pickDirectory = vi.fn(async () => ({ kind: "selected" as const, path: "/tmp/project" }));
		const openTarget = vi.fn(async () => {});
		const openProject = vi.fn(async () => ({ kind: "opened" as const }));
		const integrations = createRuntimeHostIntegrations({
			capabilities: { nativeUiAvailable: true },
			pickDirectory,
			openTarget,
			openProject,
		});

		await expect(integrations.pickDirectory()).resolves.toEqual({ ok: true, path: "/tmp/project" });
		await expect(integrations.openPath("/tmp/project/file.txt")).resolves.toEqual({ ok: true });
		await expect(integrations.openExternalUrl("https://example.com")).resolves.toEqual({ ok: true });
		await expect(integrations.openProject("vscode", "/tmp/project")).resolves.toEqual({ ok: true });
		expect(openTarget).toHaveBeenNthCalledWith(1, "/tmp/project/file.txt");
		expect(openTarget).toHaveBeenNthCalledWith(2, "https://example.com");
		expect(openProject).toHaveBeenCalledWith("vscode", "/tmp/project");
	});

	it("reports launcher absence separately from launch failures", async () => {
		const unavailableError = Object.assign(new Error("opener missing"), { code: "ENOENT" });
		const integrations = createRuntimeHostIntegrations({
			capabilities: { nativeUiAvailable: true },
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
