import { describe, expect, it, vi } from "vitest";
import {
	DESKTOP_DRAFT_SAVE_MAX_BYTES,
	type DesktopCommandAvailability,
	type DesktopDraftSaveRequest,
	type DesktopNotificationContext,
	type DesktopQuitPreflightResponse,
} from "../../src/shared/desktop-bridge-contract.js";
import {
	DESKTOP_AVAILABILITY_CHANNEL,
	DESKTOP_COMMAND_CHANNEL,
	DESKTOP_DRAFT_SAVE_CHANNEL,
	DESKTOP_NOTIFICATION_CONTEXT_CHANNEL,
	DESKTOP_NOTIFICATION_TARGET_CHANNEL,
	DESKTOP_PREFLIGHT_CHANNEL,
	DESKTOP_PREFLIGHT_RELEASE_CHANNEL,
	DESKTOP_PREFLIGHT_REPLY_CHANNEL,
	DESKTOP_PROJECT_OPEN_CHANNEL,
} from "../src/desktop-ipc-channels.js";
import { createDesktopBridge } from "../src/preload-bridge.js";

const generation = "generation-current";
const documentId = "document-current";
type Ipc = Parameters<typeof createDesktopBridge>[1];
type Subscription = "onCommand" | "onOpenProject" | "onNotificationTarget" | "onQuitPreflight" | "onPreflightReleased";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Required desktop bridge method missing");
	return value;
}

function fixture() {
	const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
	const invoke = vi.fn<Ipc["invoke"]>().mockResolvedValue({ kind: "saved" });
	const ipc: Ipc = {
		on: (channel, listener) => {
			const callbacks = listeners.get(channel) ?? new Set();
			callbacks.add(listener);
			listeners.set(channel, callbacks);
		},
		removeListener: vi.fn((channel, listener) => {
			listeners.get(channel)?.delete(listener);
		}),
		send: vi.fn<Ipc["send"]>(),
		invoke,
	};
	const bootstrap = {
		runtimeOrigin: "http://127.0.0.1:12345",
		runtimeGeneration: generation,
		capabilities: { desktop: true as const, nativeDialogs: true, nativeNotifications: false },
	};
	const bridge = createDesktopBridge(bootstrap, ipc, documentId);
	const emit = (channel: string, payload: unknown): void => {
		for (const listener of listeners.get(channel) ?? []) listener({ nativeEvent: true }, payload);
	};
	return { ipc, invoke, bootstrap, bridge, emit };
}

const status = { dirtyEditorCount: 0, activeSessionCount: 1, needsInputSessionCount: 1, runtimeConnected: true };
const response: DesktopQuitPreflightResponse = {
	requestId: "request-1",
	runtimeGeneration: generation,
	decision: "ready",
	status,
};

describe("desktop preload bridge", () => {
	it("freezes copied public bootstrap data without exposing document identity or IPC", () => {
		const { bridge, bootstrap, ipc } = fixture();
		expect(Object.isFrozen(bridge)).toBe(true);
		expect(Object.isFrozen(bridge.bootstrap)).toBe(true);
		expect(Object.isFrozen(bridge.bootstrap.capabilities)).toBe(true);
		expect(bridge.version).toBe(1);
		expect(bridge.bootstrap).toEqual(bootstrap);
		expect(Object.keys(bridge.bootstrap).sort()).toEqual(["capabilities", "runtimeGeneration", "runtimeOrigin"]);
		expect(bridge).not.toHaveProperty("documentId");
		expect(bridge).not.toHaveProperty("token");
		expect(bridge).not.toHaveProperty("ipc");
		bootstrap.runtimeGeneration = "replacement";
		bootstrap.capabilities.nativeDialogs = false;
		expect(bridge.bootstrap.runtimeGeneration).toBe(generation);
		expect(bridge.bootstrap.capabilities.nativeDialogs).toBe(true);
		required(bridge.reportNotificationContext)({ currentProjectId: null });
		expect(ipc.send).toHaveBeenCalledWith(DESKTOP_NOTIFICATION_CONTEXT_CHANNEL, {
			documentId,
			runtimeGeneration: generation,
			context: { currentProjectId: null },
		});
	});

	it.each<{ method: Subscription; channel: string; payload: Record<string, unknown>; invalid: unknown }>([
		{
			method: "onOpenProject",
			channel: DESKTOP_PROJECT_OPEN_CHANNEL,
			payload: { runtimeGeneration: generation, projectPath: "/private/tmp/project" },
			invalid: { runtimeGeneration: generation, projectPath: "relative/project" },
		},
		{
			method: "onCommand",
			channel: DESKTOP_COMMAND_CHANNEL,
			payload: { runtimeGeneration: generation, command: "settings" },
			invalid: { runtimeGeneration: generation, command: "execute-shell" },
		},
		{
			method: "onNotificationTarget",
			channel: DESKTOP_NOTIFICATION_TARGET_CHANNEL,
			payload: { runtimeGeneration: generation, projectId: "project-1", taskId: "task-1" },
			invalid: { runtimeGeneration: generation, projectId: null, taskId: "task-1" },
		},
		{
			method: "onQuitPreflight",
			channel: DESKTOP_PREFLIGHT_CHANNEL,
			payload: { runtimeGeneration: generation, requestId: "request-1", reason: "reload", freezeUntil: 12345 },
			invalid: { runtimeGeneration: generation, requestId: "request-1", reason: "quit", freezeUntil: -1 },
		},
		{
			method: "onPreflightReleased",
			channel: DESKTOP_PREFLIGHT_RELEASE_CHANNEL,
			payload: { runtimeGeneration: generation, requestId: "request-1" },
			invalid: { runtimeGeneration: generation, requestId: "../invalid" },
		},
	])(
		"$method delivers only current typed payloads and unsubscribes its own listener",
		({ method, channel, payload, invalid }) => {
			const { bridge, ipc, emit } = fixture();
			const listener = vi.fn();
			const anotherListener = vi.fn();
			const unsubscribe = required(bridge[method])(listener);
			const unsubscribeAnother = required(bridge[method])(anotherListener);
			for (const rejected of [
				null,
				invalid,
				{ ...payload, runtimeGeneration: "stale" },
				{ ...payload, arbitrary: true },
			])
				emit(channel, rejected);
			expect(listener).not.toHaveBeenCalled();
			emit(channel, payload);
			expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
			unsubscribe();
			emit(channel, payload);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(anotherListener).toHaveBeenCalledTimes(2);
			expect(ipc.removeListener).toHaveBeenCalledTimes(1);
			unsubscribeAnother();
		},
	);

	it("envelopes command availability with the private document and captured generation", () => {
		const { bridge, ipc } = fixture();
		const availability: DesktopCommandAvailability = {
			runtimeGeneration: generation,
			commands: ["settings", "new-task", "terminal"],
			runtimeConnected: true,
		};
		required(bridge.publishCommandAvailability)(availability);
		expect(ipc.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_AVAILABILITY_CHANNEL, {
			documentId,
			runtimeGeneration: generation,
			availability,
		});
	});

	it("suppresses stale, duplicated, unknown, excessive and extended availability payloads", () => {
		const { bridge, ipc } = fixture();
		const valid = { runtimeGeneration: generation, commands: ["settings"], runtimeConnected: true };
		for (const invalid of [
			{ ...valid, runtimeGeneration: "stale" },
			{ ...valid, commands: ["settings", "settings"] },
			{ ...valid, commands: ["execute-shell"] },
			{ ...valid, commands: Array(12).fill("settings") },
			{ ...valid, runtimeConnected: "true" },
			{ ...valid, documentId: "forged" },
		])
			required(bridge.publishCommandAvailability)(invalid as DesktopCommandAvailability);
		expect(ipc.send).not.toHaveBeenCalled();
	});

	it("allows only bounded project identity in notification context", () => {
		const { bridge, ipc } = fixture();
		for (const context of [{ currentProjectId: null }, { currentProjectId: "project-1" }])
			required(bridge.reportNotificationContext)(context);
		for (const invalid of [
			{ currentProjectId: "../project" },
			{ currentProjectId: "p".repeat(129) },
			{ currentProjectId: null, taskId: "task-1" },
			{ currentProjectId: null, runtimeGeneration: "forged" },
			{ currentProjectId: null, url: "file:///private/path" },
		])
			required(bridge.reportNotificationContext)(invalid as DesktopNotificationContext);
		expect(ipc.send).toHaveBeenCalledTimes(2);
		expect(ipc.send).toHaveBeenLastCalledWith(DESKTOP_NOTIFICATION_CONTEXT_CHANNEL, {
			documentId,
			runtimeGeneration: generation,
			context: { currentProjectId: "project-1" },
		});
	});

	it("envelopes valid preflight replies and rejects stale, unbounded or dirty-ready responses", () => {
		const { bridge, ipc } = fixture();
		for (const invalid of [
			{ ...response, runtimeGeneration: "stale" },
			{ ...response, status: { ...status, dirtyEditorCount: 1 } },
			{ ...response, status: { ...status, activeSessionCount: 1_000_001 } },
			{ ...response, status: { ...status, runtimeConnected: true, secret: "forbidden" } },
			{ ...response, documentId: "forged" },
		])
			required(bridge.respondQuitPreflight)(invalid as DesktopQuitPreflightResponse);
		expect(ipc.send).not.toHaveBeenCalled();
		required(bridge.respondQuitPreflight)(response);
		const blocked: DesktopQuitPreflightResponse = {
			...response,
			decision: "blocked",
			status: { ...status, dirtyEditorCount: 2 },
		};
		required(bridge.respondQuitPreflight)(blocked);
		expect(ipc.send).toHaveBeenCalledTimes(2);
		expect(ipc.send).toHaveBeenCalledWith(DESKTOP_PREFLIGHT_REPLY_CHANNEL, { documentId, response });
		expect(ipc.send).toHaveBeenLastCalledWith(DESKTOP_PREFLIGHT_REPLY_CHANNEL, { documentId, response: blocked });
	});

	it("keeps nonce envelopes distinct between documents sharing a generation", async () => {
		const { bridge, ipc, bootstrap } = fixture();
		const replacement = createDesktopBridge(bootstrap, ipc, "document-replacement");
		const request = { suggestedName: "draft.txt", content: "synthetic" };
		await required(bridge.saveEditorDraft)(request);
		await required(replacement.saveEditorDraft)(request);
		expect(ipc.invoke).toHaveBeenNthCalledWith(1, DESKTOP_DRAFT_SAVE_CHANNEL, {
			documentId,
			runtimeGeneration: generation,
			request,
		});
		expect(ipc.invoke).toHaveBeenNthCalledWith(2, DESKTOP_DRAFT_SAVE_CHANNEL, {
			documentId: "document-replacement",
			runtimeGeneration: generation,
			request,
		});
	});

	it.each(["saved", "cancelled", "failed"] as const)("returns only the typed %s draft outcome", async (kind) => {
		const { bridge, invoke } = fixture();
		invoke.mockResolvedValue({ kind });
		expect(await required(bridge.saveEditorDraft)({ suggestedName: "draft.txt", content: "synthetic" })).toEqual({
			kind,
		});
	});

	it("normalizes malformed and rejected draft replies without leaking main-process details", async () => {
		const { bridge, invoke } = fixture();
		const save = required(bridge.saveEditorDraft);
		const request = { suggestedName: "draft.txt", content: "synthetic" };
		for (const reply of [
			null,
			"saved",
			{ kind: "unknown" },
			{ kind: "saved", path: "/private/path" },
			{ kind: "failed", error: "private failure" },
		]) {
			invoke.mockResolvedValueOnce(reply);
			expect(await save(request)).toEqual({ kind: "failed" });
		}
		invoke.mockRejectedValueOnce(new Error("private failure"));
		expect(await save(request)).toEqual({ kind: "failed" });
	});

	it("rejects path-like, extended and oversized draft requests before invoking main", async () => {
		const { bridge, invoke } = fixture();
		const save = required(bridge.saveEditorDraft);
		for (const suggestedName of [
			"",
			".",
			"..",
			"../draft",
			"folder/draft",
			"folder\\draft",
			"draft\n.txt",
			"n".repeat(201),
		]) {
			expect(await save({ suggestedName, content: "synthetic" })).toEqual({ kind: "failed" });
		}
		expect(
			await save({
				suggestedName: "draft.txt",
				content: "synthetic",
				path: "/private/path",
			} as DesktopDraftSaveRequest),
		).toEqual({ kind: "failed" });
		expect(await save({ suggestedName: "draft.txt", content: "x".repeat(DESKTOP_DRAFT_SAVE_MAX_BYTES + 1) })).toEqual(
			{ kind: "failed" },
		);
		expect(
			await save({ suggestedName: "draft.txt", content: "é".repeat(DESKTOP_DRAFT_SAVE_MAX_BYTES / 2 + 1) }),
		).toEqual({ kind: "failed" });
		expect(invoke).not.toHaveBeenCalled();
	});

	it("accepts the exact UTF-8 byte limit and maximum suggested-name length", async () => {
		const { bridge, invoke } = fixture();
		const request = { suggestedName: "n".repeat(200), content: "é".repeat(DESKTOP_DRAFT_SAVE_MAX_BYTES / 2) };
		expect(await required(bridge.saveEditorDraft)(request)).toEqual({ kind: "saved" });
		expect(invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_DRAFT_SAVE_CHANNEL, {
			documentId,
			runtimeGeneration: generation,
			request,
		});
	});
});
