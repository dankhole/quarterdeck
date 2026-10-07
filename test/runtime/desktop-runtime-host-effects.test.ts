import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopHostEffectRequestMessage } from "../../src/core/api/desktop-runtime-protocol.js";
import { createRuntimeCapabilities } from "../../src/core/api/host-integrations.js";
import { DesktopHostEffectClient } from "../../src/server/desktop-host-effect-client.js";
import { createDesktopRuntimeHostEffects } from "../../src/server/desktop-runtime-host-effects.js";
import { createRuntimeHostIntegrations } from "../../src/server/runtime-host-integrations.js";

afterEach(() => vi.useRealTimers());

function clientFixture(maxPending = 8) {
	const identity = { startupId: randomUUID(), runtimeGeneration: randomUUID() };
	const sent: DesktopHostEffectRequestMessage[] = [];
	const client = new DesktopHostEffectClient({
		getIdentity: () => identity,
		send: async (message) => {
			sent.push(message);
		},
		deadlineMs: 25,
		maxPending,
	});
	return { identity, sent, client };
}

describe("bounded private desktop host requests", () => {
	it("requires exact startup, generation, request and sequence identities", async () => {
		vi.useFakeTimers();
		const f = clientFixture();
		const request = f.client.request(
			{ method: "open-path", path: "/synthetic/Project Ω" },
			f.identity.runtimeGeneration,
		);
		const message = f.sent[0];
		const response = {
			type: "quarterdeck:desktop-host-result",
			protocolVersion: 1,
			startupId: message.startupId,
			runtimeGeneration: message.runtimeGeneration,
			requestId: message.requestId,
			sequence: message.sequence,
			result: { status: "opened" },
		};
		f.client.accept({ ...response, startupId: randomUUID() });
		f.client.accept({ ...response, runtimeGeneration: randomUUID() });
		f.client.accept({ ...response, requestId: randomUUID() });
		f.client.accept({ ...response, sequence: 999 });
		f.client.accept({ ...response, result: { status: "selected", path: "/wrong/response" } });
		let settled = false;
		void request.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		f.client.accept(response);
		await expect(request).resolves.toEqual({ status: "opened" });
		f.client.dispose();
	});
	it("bounds outstanding requests, times out and drains on parent loss", async () => {
		vi.useFakeTimers();
		const f = clientFixture(1);
		const first = f.client.request({ method: "pick-directory" }, f.identity.runtimeGeneration);
		await expect(f.client.request({ method: "pick-directory" }, f.identity.runtimeGeneration)).resolves.toEqual({
			status: "failed",
			reason: "busy",
		});
		await vi.advanceTimersByTimeAsync(25);
		await expect(first).resolves.toEqual({ status: "failed", reason: "timeout" });
		const pending = f.client.request({ method: "pick-directory" }, f.identity.runtimeGeneration);
		f.client.dispose();
		await expect(pending).resolves.toEqual({ status: "failed", reason: "disconnected" });
		await expect(f.client.request({ method: "pick-directory" }, f.identity.runtimeGeneration)).resolves.toEqual({
			status: "failed",
			reason: "disconnected",
		});
		expect(f.sent).toHaveLength(2);
	});
	it("fails closed without sending invalid actions or another generation", async () => {
		const f = clientFixture();
		await expect(
			f.client.request({ method: "open-external-url", url: "javascript:alert(1)" }, f.identity.runtimeGeneration),
		).resolves.toEqual({ status: "failed", reason: "denied" });
		await expect(f.client.request({ method: "pick-directory" }, randomUUID())).resolves.toEqual({
			status: "failed",
			reason: "disconnected",
		});
		expect(f.sent).toEqual([]);
	});
	it("returns a typed disconnected outcome when the private send fails", async () => {
		const identity = { startupId: randomUUID(), runtimeGeneration: randomUUID() };
		const client = new DesktopHostEffectClient({
			getIdentity: () => identity,
			send: () => {
				throw new Error("private send failed");
			},
		});
		await expect(client.request({ method: "pick-directory" }, identity.runtimeGeneration)).resolves.toEqual({
			status: "failed",
			reason: "disconnected",
		});
		client.dispose();
	});
});

describe("host integration injection", () => {
	it("keeps authoritative disabled capability ahead of private IPC", async () => {
		const request = vi.fn(async () => ({ status: "opened" as const }));
		const host = createRuntimeHostIntegrations({
			capabilities: createRuntimeCapabilities("unavailable"),
			...createDesktopRuntimeHostEffects(request, randomUUID()),
		});
		await expect(host.pickDirectory()).resolves.toMatchObject({ ok: false, reason: "native_ui_unavailable" });
		await expect(host.openPath("/synthetic/project")).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
		await expect(host.openExternalUrl("https://example.com")).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
		await expect(host.openProject("vscode", "/synthetic/project")).resolves.toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
		expect(request).not.toHaveBeenCalled();
	});
	it("returns picker cancellation and routes runtime-derived targets as typed effects", async () => {
		const generation = randomUUID();
		const request = vi.fn(async (action: { method: string }) =>
			action.method === "pick-directory" ? { status: "cancelled" as const } : { status: "opened" as const },
		);
		const host = createRuntimeHostIntegrations({
			capabilities: createRuntimeCapabilities("native"),
			...createDesktopRuntimeHostEffects(request, generation),
		});
		await expect(host.pickDirectory()).resolves.toMatchObject({ ok: false, reason: "cancelled" });
		await expect(host.openPath("/synthetic/project Ω")).resolves.toEqual({ ok: true, outcome: "native" });
		await expect(host.openExternalUrl("https://example.com")).resolves.toEqual({ ok: true, outcome: "native" });
		await expect(host.openProject("vscode", "/synthetic/project Ω")).resolves.toEqual({
			ok: true,
			outcome: "native",
		});
		expect(request.mock.calls).toEqual([
			[{ method: "pick-directory" }, generation],
			[{ method: "open-path", path: "/synthetic/project Ω" }, generation],
			[{ method: "open-external-url", url: "https://example.com" }, generation],
			[{ method: "open-project", targetId: "vscode", path: "/synthetic/project Ω" }, generation],
		]);
	});
	it("preserves unavailable native launch outcomes without exposing parent errors", async () => {
		const request = vi.fn(async () => ({ status: "failed" as const, reason: "unavailable" as const }));
		const host = createRuntimeHostIntegrations({
			capabilities: createRuntimeCapabilities("native"),
			...createDesktopRuntimeHostEffects(request, randomUUID()),
		});
		await expect(host.pickDirectory()).resolves.toMatchObject({ ok: false, reason: "launcher_unavailable" });
		await expect(host.openProject("vscode", "/synthetic/project")).resolves.toMatchObject({
			ok: false,
			reason: "launcher_unavailable",
		});
	});
});
