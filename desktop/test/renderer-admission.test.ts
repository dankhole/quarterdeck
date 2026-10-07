import type {
	IpcMainEvent,
	OnBeforeRequestListenerDetails,
	OnBeforeSendHeadersListenerDetails,
	PermissionRequest,
	Session,
	WebContents,
	WebFrameMain,
} from "electron";
import { describe, expect, it } from "vitest";
import {
	type ApprovedRenderer,
	installRendererAdmission,
	isAdmittedClipboardPermission,
	isAdmittedSocket,
	isBootstrapPayload,
	isBootstrapSender,
} from "../src/renderer-admission.js";
import { RuntimeSelection } from "../src/runtime-selection.js";
import { DESKTOP_TOKEN_HEADER } from "../src/security-policy.js";

function fixture(): {
	renderer: ApprovedRenderer;
	selection: RuntimeSelection;
	socket: OnBeforeRequestListenerDetails;
} {
	const mainFrame = { url: "app://quarterdeck/" } as WebFrameMain;
	const contents = { id: 42, mainFrame, isDestroyed: () => false } as WebContents;
	const renderer = { contents, generation: "first", documentId: "current-document" };
	const selection = new RuntimeSelection();
	selection.select({ generation: "first", origin: "http://127.0.0.1:12345", clientToken: "a".repeat(43) });
	const socket = {
		url: "ws://127.0.0.1:12345/api/runtime/ws",
		webContentsId: 42,
		frame: mainFrame,
		resourceType: "webSocket",
		initiatorOrigin: "app://quarterdeck",
	} as OnBeforeRequestListenerDetails;
	return { renderer, selection, socket };
}

describe("renderer admission", () => {
	it("pins a WebSocket credential to the exact approved main frame and live generation", () => {
		const { renderer, selection, socket } = fixture();
		expect(isAdmittedSocket(socket, renderer, selection)).toBe(true);
		for (const change of [
			{ webContentsId: 43 },
			{ frame: { url: "app://quarterdeck/" } as WebFrameMain },
			{ initiatorOrigin: "https://example.test" },
			{ initiatorOrigin: undefined },
			{ resourceType: "xhr" as const },
			{ url: "ws://127.0.0.1:54321/api/runtime/ws" },
		])
			expect(isAdmittedSocket({ ...socket, ...change }, renderer, selection)).toBe(false);
		expect(isAdmittedSocket(socket, { ...renderer, generation: "previous" }, selection)).toBe(false);
		Object.defineProperty(renderer.contents.mainFrame, "url", { value: "app://quarterdeck/__desktop/error" });
		expect(isAdmittedSocket(socket, renderer, selection)).toBe(false);
	});

	it("admits only a typed bootstrap payload from the approved top frame", () => {
		const { renderer, selection } = fixture();
		const event = { sender: renderer.contents, senderFrame: renderer.contents.mainFrame } as IpcMainEvent;
		expect(isBootstrapSender(event, renderer, selection)).toBe(true);
		expect(isBootstrapSender({ ...event, senderFrame: null }, renderer, selection)).toBe(false);
		expect(isBootstrapSender({ ...event, sender: { id: 42 } as WebContents }, renderer, selection)).toBe(false);
		expect(isBootstrapPayload({ version: 1 })).toBe(true);
		for (const payload of [null, {}, [], { version: "1" }, { version: 2 }, { version: 1, url: "file:///tmp" }])
			expect(isBootstrapPayload(payload)).toBe(false);
		selection.clear();
		expect(isBootstrapSender(event, renderer, selection)).toBe(false);
	});

	it("allows clipboard APIs only in the sealed approved top-level product document", () => {
		const { renderer } = fixture();
		const details = { isMainFrame: true, requestingUrl: "app://quarterdeck/" };
		for (const permission of ["clipboard-read", "clipboard-sanitized-write"] as const) {
			expect(isAdmittedClipboardPermission(renderer.contents, permission, details, renderer)).toBe(true);
			for (const change of [
				{ isMainFrame: false },
				{ requestingUrl: undefined },
				{ requestingUrl: "app://quarterdeck/projects/previous" },
				{ requestingUrl: "app://quarterdeck/__desktop/error" },
				{ requestingUrl: "https://example.test/" },
				{ requestingUrl: "app://other/" },
			]) {
				expect(
					isAdmittedClipboardPermission(renderer.contents, permission, { ...details, ...change }, renderer),
				).toBe(false);
			}
			for (const denied of [
				null,
				{ ...renderer, generation: null },
				{ ...renderer, documentId: null },
				{ ...renderer, contents: { ...renderer.contents, isDestroyed: () => true } as WebContents },
			]) {
				expect(isAdmittedClipboardPermission(renderer.contents, permission, details, denied)).toBe(false);
			}
			expect(isAdmittedClipboardPermission(null, permission, details, renderer)).toBe(false);
			expect(
				isAdmittedClipboardPermission({ id: renderer.contents.id } as WebContents, permission, details, renderer),
			).toBe(false);
		}
		for (const permission of [
			"deprecated-sync-clipboard-read",
			"media",
			"notifications",
			"openExternal",
			"fileSystem",
			"unknown",
		] as const) {
			expect(isAdmittedClipboardPermission(renderer.contents, permission, details, renderer)).toBe(false);
		}
		Object.defineProperty(renderer.contents.mainFrame, "url", { value: "app://quarterdeck/__desktop/error" });
		expect(
			isAdmittedClipboardPermission(
				renderer.contents,
				"clipboard-read",
				{ ...details, requestingUrl: renderer.contents.mainFrame.url },
				renderer,
			),
		).toBe(false);
	});

	it("keeps local Copy available offline while revoking network access and navigation seals", () => {
		const { renderer, selection, socket } = fixture();
		type CheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
		type RequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
		const handlers: { check?: CheckHandler; request?: RequestHandler } = {};
		const session = {
			webRequest: { onBeforeRequest: () => undefined, onBeforeSendHeaders: () => undefined },
			setPermissionCheckHandler: (handler: CheckHandler) => {
				handlers.check = handler;
			},
			setPermissionRequestHandler: (handler: RequestHandler) => {
				handlers.request = handler;
			},
			setDevicePermissionHandler: () => undefined,
			on: () => undefined,
		} as unknown as Session;
		installRendererAdmission(session, () => renderer, selection);
		const check = handlers.check;
		const request = handlers.request;
		if (!check || !request) throw new Error("Both permission handlers must be installed.");
		const details: PermissionRequest = { isMainFrame: true, requestingUrl: renderer.contents.mainFrame.url };
		for (const permission of ["clipboard-read", "clipboard-sanitized-write"] as const) {
			expect(check(renderer.contents, permission, "app://quarterdeck", details)).toBe(true);
			request(renderer.contents, permission, (granted) => expect(granted).toBe(true), details);
			expect(check(renderer.contents, permission, "https://example.test", details)).toBe(false);
			request(renderer.contents, permission, (granted) => expect(granted).toBe(false), {
				...details,
				isMainFrame: false,
			});
		}
		expect(check(renderer.contents, "notifications", "app://quarterdeck", details)).toBe(false);
		request(renderer.contents, "openExternal", (granted) => expect(granted).toBe(false), details);
		selection.clear();
		expect(isAdmittedSocket(socket, renderer, selection)).toBe(false);
		expect(check(renderer.contents, "clipboard-read", "app://quarterdeck", details)).toBe(true);
		request(renderer.contents, "clipboard-sanitized-write", (granted) => expect(granted).toBe(true), details);
		renderer.documentId = null;
		expect(check(renderer.contents, "clipboard-read", "app://quarterdeck", details)).toBe(false);
		request(renderer.contents, "clipboard-sanitized-write", (granted) => expect(granted).toBe(false), details);
	});

	it("injects credentials on the main-process interception path and denies other endpoints", () => {
		const { renderer, selection, socket } = fixture();
		type HeadersListener = NonNullable<Parameters<Session["webRequest"]["onBeforeSendHeaders"]>[0]>;
		const handlers: { headers?: HeadersListener } = {};
		const session = {
			webRequest: {
				onBeforeRequest: () => undefined,
				onBeforeSendHeaders: (_filter: unknown, handler: HeadersListener) => {
					handlers.headers = handler;
				},
			},
			setPermissionCheckHandler: () => undefined,
			setPermissionRequestHandler: () => undefined,
			setDevicePermissionHandler: () => undefined,
			on: () => undefined,
		} as unknown as Session;
		installRendererAdmission(session, () => renderer, selection);
		for (const path of ["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"]) {
			const request = {
				...socket,
				url: `ws://127.0.0.1:12345${path}`,
				requestHeaders: {
					[DESKTOP_TOKEN_HEADER.toLowerCase()]: "forged",
					Authorization: "forged",
					Origin: "app://quarterdeck",
				},
			} as OnBeforeSendHeadersListenerDetails;
			handlers.headers?.(request, (response) => {
				expect(response.cancel).not.toBe(true);
				expect(response.requestHeaders?.[DESKTOP_TOKEN_HEADER]).toBe("a".repeat(43));
				expect(response.requestHeaders?.Authorization).toBeUndefined();
			});
		}
		for (const query of [
			"notificationPresentation=desktop-main",
			"%6eotificationOnly=1",
			"notificationOnly=0&notificationOnly=1",
		]) {
			handlers.headers?.(
				{
					...socket,
					url: `ws://127.0.0.1:12345/api/runtime/ws?${query}`,
					requestHeaders: { [DESKTOP_TOKEN_HEADER]: "forged" },
				} as OnBeforeSendHeadersListenerDetails,
				(response) => {
					expect(response.cancel).toBe(true);
					expect(response.requestHeaders?.[DESKTOP_TOKEN_HEADER]).toBeUndefined();
				},
			);
		}
		handlers.headers?.(
			{
				...socket,
				url: "ws://127.0.0.1:12345/api/diagnostics",
				requestHeaders: { [DESKTOP_TOKEN_HEADER]: "forged" },
			} as OnBeforeSendHeadersListenerDetails,
			(response) => {
				expect(response.cancel).toBe(true);
				expect(response.requestHeaders?.[DESKTOP_TOKEN_HEADER]).toBeUndefined();
			},
		);
	});
});
