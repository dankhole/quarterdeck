import { EventEmitter } from "node:events";
import type { IpcMain, IpcMainEvent, WebContents, WebFrameMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import type {
	DesktopNotificationContext,
	DesktopQuitPreflightRequest,
} from "../../src/shared/desktop-bridge-contract.js";
import {
	DESKTOP_AVAILABILITY_CHANNEL,
	DESKTOP_NOTIFICATION_CONTEXT_CHANNEL,
	DESKTOP_PREFLIGHT_RELEASE_CHANNEL,
	DESKTOP_PROJECT_OPEN_CHANNEL,
} from "../src/desktop-ipc-channels.js";
import {
	DESKTOP_COMMAND_CHANNEL,
	DESKTOP_PREFLIGHT_CHANNEL,
	DESKTOP_PREFLIGHT_REPLY_CHANNEL,
	DesktopRendererCommands,
} from "../src/renderer-commands.js";
import { RuntimeSelection } from "../src/runtime-selection.js";

function fixture(onContext?: (context: DesktopNotificationContext) => void) {
	const ipc = new EventEmitter() as IpcMain;
	const sent: { channel: string; payload: unknown }[] = [];
	const contents = {
		id: 42,
		mainFrame: { url: "app://quarterdeck/" } as WebFrameMain,
		isDestroyed: () => false,
		getURL: () => "app://quarterdeck/",
		send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
	} as unknown as WebContents;
	const renderer = { contents, generation: "first", documentId: "document-first" };
	const selection = new RuntimeSelection();
	selection.select({ generation: "first", origin: "http://127.0.0.1:12345", clientToken: "a".repeat(43) });
	const commands = new DesktopRendererCommands(ipc, () => renderer, selection, 30, { onContext });
	const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainEvent;
	return { ipc, sent, renderer, selection, commands, event };
}

function reply(response: unknown) {
	return { documentId: "document-first", response };
}

function readyReply(request: DesktopQuitPreflightRequest) {
	return {
		requestId: request.requestId,
		runtimeGeneration: request.runtimeGeneration,
		decision: "ready",
		status: { dirtyEditorCount: 0, activeSessionCount: 0, needsInputSessionCount: 0, runtimeConnected: true },
	};
}

describe("typed renderer commands and quit preflight", () => {
	it("dispatches project opens only after the exact admitted document publishes connected project navigation", () => {
		const { commands, sent, ipc, event, selection } = fixture();
		const request = { runtimeGeneration: "first", projectPath: "/private/tmp/project" };
		expect(commands.openProject(request)).toBe(false);
		const publish = (runtimeConnected: boolean, names: string[], projectLaunchReady?: boolean) =>
			ipc.emit(DESKTOP_AVAILABILITY_CHANNEL, event, {
				documentId: "document-first",
				runtimeGeneration: "first",
				availability: { runtimeGeneration: "first", runtimeConnected, commands: names, projectLaunchReady },
			});
		publish(false, ["open-project"]);
		expect(commands.openProject(request)).toBe(false);
		publish(true, ["settings"]);
		expect(commands.openProject(request)).toBe(false);
		publish(true, ["open-project"]);
		expect(commands.openProject(request)).toBe(false);
		publish(true, ["open-project"], false);
		expect(commands.openProject(request)).toBe(false);
		publish(true, ["open-project"], true);
		expect(commands.openProject({ ...request, projectPath: "relative" })).toBe(false);
		expect(commands.openProject(request)).toBe(true);
		expect(sent).toEqual([{ channel: DESKTOP_PROJECT_OPEN_CHANNEL, payload: request }]);
		selection.select({ generation: "second", origin: "http://127.0.0.1:12346", clientToken: "b".repeat(43) });
		expect(commands.openProject(request)).toBe(false);
		commands.dispose();
	});
	it("requests an acknowledged navigation hold and releases only its matching retired document on proven cancellation", async () => {
		const { commands, sent, ipc, event, renderer } = fixture();
		const pending = commands.requestPreflight("reload", true, "navigation");
		const request = sent[0]?.payload as DesktopQuitPreflightRequest;
		expect(request).toMatchObject({ reason: "reload", freezeMode: "navigation" });
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply(readyReply(request)));
		await pending;
		commands.clearDocument();
		renderer.documentId = "provisional-document";
		expect(sent.some((entry) => entry.channel === DESKTOP_PREFLIGHT_RELEASE_CHANNEL)).toBe(false);
		renderer.documentId = "document-first";
		commands.releasePreflight();
		expect(sent.filter((entry) => entry.channel === DESKTOP_PREFLIGHT_RELEASE_CHANNEL)).toEqual([
			{
				channel: DESKTOP_PREFLIGHT_RELEASE_CHANNEL,
				payload: { requestId: request.requestId, runtimeGeneration: request.runtimeGeneration },
			},
		]);
		commands.dispose();
	});
	it("actual document retirement forgets the old navigation hold without releasing it to a replacement", async () => {
		const { commands, sent, ipc, event, renderer } = fixture();
		const pending = commands.requestPreflight("reload", true, "navigation");
		const request = sent[0]?.payload as DesktopQuitPreflightRequest;
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply(readyReply(request)));
		await pending;
		commands.clearDocument();
		renderer.documentId = "committed-document";
		commands.forgetRetiredNavigation();
		commands.releasePreflight();
		expect(sent.some((entry) => entry.channel === DESKTOP_PREFLIGHT_RELEASE_CHANNEL)).toBe(false);
		commands.dispose();
	});
	it("navigation invalidation revokes admission without unfreezing the surviving old document", async () => {
		const { commands, sent, ipc, event } = fixture();
		const pending = commands.requestPreflight("reload", true);
		const request = sent[0]?.payload as DesktopQuitPreflightRequest;
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply(readyReply(request)));
		const response = await pending;
		expect(response && commands.isSealValid(response)).toBe(true);
		commands.clearDocument();
		commands.releasePreflight();
		expect(response && commands.isSealValid(response)).toBe(false);
		expect(sent.some((entry) => entry.channel === DESKTOP_PREFLIGHT_RELEASE_CHANNEL)).toBe(false);
		commands.dispose();
	});
	it("sends one generation-scoped command and refuses stale renderer generations", () => {
		const { commands, sent, selection, ipc, event } = fixture();
		expect(commands.dispatch("settings")).toBe(false);
		ipc.emit(DESKTOP_AVAILABILITY_CHANNEL, event, {
			documentId: "document-first",
			runtimeGeneration: "first",
			availability: { runtimeGeneration: "first", commands: ["settings"], runtimeConnected: true },
		});
		expect(commands.dispatch("settings")).toBe(true);
		expect(sent).toEqual([
			{ channel: DESKTOP_COMMAND_CHANNEL, payload: { runtimeGeneration: "first", command: "settings" } },
		]);
		selection.select({ generation: "second", origin: "http://127.0.0.1:12346", clientToken: "b".repeat(43) });
		expect(commands.dispatch("settings")).toBe(false);
		expect(sent).toHaveLength(1);
		commands.dispose();
	});
	it("accepts publication only from the current document and keeps offline settings available", () => {
		const { commands, ipc, event, selection, renderer } = fixture();
		const envelope = {
			documentId: "document-first",
			runtimeGeneration: "first",
			availability: { runtimeGeneration: "first", commands: ["settings", "new-task"], runtimeConnected: true },
		};
		ipc.emit(DESKTOP_AVAILABILITY_CHANNEL, { ...event, senderFrame: null }, envelope);
		ipc.emit(DESKTOP_AVAILABILITY_CHANNEL, event, { ...envelope, documentId: "old-document" });
		expect(commands.availability()).toBeNull();
		ipc.emit(DESKTOP_AVAILABILITY_CHANNEL, event, envelope);
		selection.clear();
		expect(commands.dispatch("settings")).toBe(true);
		expect(commands.dispatch("new-task")).toBe(false);
		renderer.documentId = "replacement";
		expect(commands.dispatch("settings")).toBe(false);
		commands.dispose();
	});
	it("allows sealed offline preflight but revokes its authority on document replacement", async () => {
		const { commands, selection, sent, ipc, event, renderer } = fixture();
		selection.clear();
		const pending = commands.requestPreflight("reload", true);
		const request = sent[0]?.payload as DesktopQuitPreflightRequest;
		ipc.emit(
			DESKTOP_PREFLIGHT_REPLY_CHANNEL,
			event,
			reply({ ...readyReply(request), status: { ...readyReply(request).status, runtimeConnected: false } }),
		);
		const response = await pending;
		expect(response?.decision).toBe("ready");
		expect(response && commands.isSealValid(response)).toBe(true);
		renderer.documentId = "replacement";
		expect(response && commands.isSealValid(response)).toBe(false);
		commands.clearDocument();
		expect(commands.availability()).toBeNull();
		commands.dispose();
	});
	it("uses document-scoped validated context without treating renderer focus as authority", () => {
		const onContext = vi.fn();
		const { ipc, event, commands } = fixture(onContext);
		const envelope = {
			documentId: "document-first",
			runtimeGeneration: "first",
			context: { currentProjectId: "project" },
		};
		ipc.emit(DESKTOP_NOTIFICATION_CONTEXT_CHANNEL, event, { ...envelope, documentId: "stale" });
		ipc.emit(DESKTOP_NOTIFICATION_CONTEXT_CHANNEL, event, {
			...envelope,
			context: { currentProjectId: "project", focused: true },
		});
		ipc.emit(DESKTOP_NOTIFICATION_CONTEXT_CHANNEL, event, envelope);
		expect(onContext).toHaveBeenCalledExactlyOnceWith({ currentProjectId: "project" });
		commands.dispose();
	});
	it("expires the final input seal even if the document remains current", async () => {
		vi.useFakeTimers({ toFake: ["Date", "performance"] });
		try {
			const { commands, sent, ipc, event } = fixture();
			const pending = commands.requestPreflight("reload", true);
			const request = sent[0]?.payload as DesktopQuitPreflightRequest;
			ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply(readyReply(request)));
			const response = await pending;
			expect(response && commands.isSealValid(response)).toBe(true);
			vi.advanceTimersByTime(30_001);
			expect(response && commands.isSealValid(response)).toBe(false);
			commands.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("accepts only the matching top-frame response for the pending request", async () => {
		const { commands, ipc, event, sent } = fixture();
		const pending = commands.requestPreflight("quit");
		const request = sent[0]?.payload as DesktopQuitPreflightRequest;
		expect(sent[0]?.channel).toBe(DESKTOP_PREFLIGHT_CHANNEL);
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, { ...event, senderFrame: null }, reply(readyReply(request)));
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply({ ...readyReply(request), requestId: "other" }));
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply({ ...readyReply(request), runtimeGeneration: "other" }));
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply(readyReply(request)));
		expect(await pending).toEqual(readyReply(request));
		commands.dispose();
	});

	it("rejects a ready response with dirty editors but accepts its explicit frontend veto", async () => {
		const { commands, ipc, event, sent } = fixture();
		const pending = commands.requestPreflight("quit");
		const request = sent[0]?.payload as DesktopQuitPreflightRequest;
		const response = { ...readyReply(request), status: { ...readyReply(request).status, dirtyEditorCount: 2 } };
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply(response));
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply({ ...response, decision: "blocked" }));
		expect(await pending).toMatchObject({ decision: "blocked", status: { dirtyEditorCount: 2 } });
		commands.dispose();
	});

	it("fails closed for a hung renderer and immediately invalidates a changed runtime generation", async () => {
		const first = fixture();
		expect(await first.commands.requestPreflight("update")).toBeNull();
		first.commands.dispose();
		const second = fixture();
		const pending = second.commands.requestPreflight("quit");
		second.selection.clear();
		expect(await pending).toBeNull();
		second.commands.dispose();
	});

	it("retires an old request when a newer user action replaces it", async () => {
		const { commands, sent, ipc, event } = fixture();
		const first = commands.requestPreflight("quit");
		const oldRequest = sent[0]?.payload as DesktopQuitPreflightRequest;
		const second = commands.requestPreflight("update");
		const newRequest = sent[1]?.payload as DesktopQuitPreflightRequest;
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply(readyReply(oldRequest)));
		ipc.emit(DESKTOP_PREFLIGHT_REPLY_CHANNEL, event, reply(readyReply(newRequest)));
		expect(await first).toBeNull();
		expect(await second).toEqual(readyReply(newRequest));
		commands.dispose();
	});
});
