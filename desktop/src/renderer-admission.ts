import type {
	IpcMainEvent,
	OnBeforeRequestListenerDetails,
	OnBeforeSendHeadersListenerDetails,
	PermissionCheckHandlerHandlerDetails,
	PermissionRequest,
	Session,
	WebContents,
} from "electron";
import type { RuntimeSelection } from "./runtime-selection.js";

export { DESKTOP_BOOTSTRAP_CHANNEL } from "./desktop-ipc-channels.js";

import {
	DESKTOP_ORIGIN,
	DESKTOP_TOKEN_HEADER,
	desktopUrl,
	isPinnedWebSocket,
	isProductPage,
} from "./security-policy.js";

export function isBootstrapPayload(payload: unknown): boolean {
	return Boolean(
		payload &&
			typeof payload === "object" &&
			!Array.isArray(payload) &&
			Object.keys(payload).length === 1 &&
			"version" in payload &&
			payload.version === 1,
	);
}

export interface ApprovedRenderer {
	contents: WebContents;
	generation: string | null;
	documentId?: string | null;
}

type RendererRequest = Pick<
	OnBeforeRequestListenerDetails,
	"url" | "webContentsId" | "frame" | "initiatorOrigin" | "resourceType"
>;

type Permission = Parameters<NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>>[1];

/** Local recovery survives helper loss. Electron supplies no clipboard user-gesture field. */
export function isAdmittedClipboardPermission(
	contents: WebContents | null,
	permission: Permission,
	details: PermissionRequest | PermissionCheckHandlerHandlerDetails,
	renderer: ApprovedRenderer | null,
): boolean {
	return Boolean(
		(permission === "clipboard-read" || permission === "clipboard-sanitized-write") &&
			renderer?.documentId &&
			renderer.generation &&
			!renderer.contents.isDestroyed() &&
			contents === renderer.contents &&
			details.isMainFrame &&
			isProductPage(renderer.contents.mainFrame.url) &&
			details.requestingUrl === renderer.contents.mainFrame.url,
	);
}

export function isAdmittedSocket(
	request: RendererRequest,
	renderer: ApprovedRenderer | null,
	selection: RuntimeSelection,
): boolean {
	const runtime = selection.get();
	return Boolean(
		renderer &&
			runtime &&
			renderer.generation === runtime.generation &&
			!renderer.contents.isDestroyed() &&
			request.webContentsId === renderer.contents.id &&
			request.frame === renderer.contents.mainFrame &&
			isProductPage(renderer.contents.mainFrame.url) &&
			request.initiatorOrigin === DESKTOP_ORIGIN &&
			request.resourceType === "webSocket" &&
			isPinnedWebSocket(request.url, runtime.origin),
	);
}

export function isBootstrapSender(
	event: Pick<IpcMainEvent, "sender" | "senderFrame">,
	renderer: ApprovedRenderer | null,
	selection: RuntimeSelection,
): boolean {
	return (
		isApprovedDocumentSender(event, renderer, renderer?.generation ?? null) &&
		Boolean(selection.get() && renderer?.generation === selection.get()?.generation)
	);
}

/** Recovery saves/preflight remain available to the surviving document after runtime authority is revoked. */
export function isApprovedDocumentSender(
	event: Pick<IpcMainEvent, "sender" | "senderFrame">,
	renderer: ApprovedRenderer | null,
	generation: string | null,
): boolean {
	return Boolean(
		renderer &&
			generation &&
			renderer.generation === generation &&
			!renderer.contents.isDestroyed() &&
			event.sender === renderer.contents &&
			event.senderFrame === renderer.contents.mainFrame &&
			event.senderFrame &&
			isProductPage(event.senderFrame.url) &&
			renderer.generation === generation,
	);
}

export function installRendererAdmission(
	session: Session,
	getRenderer: () => ApprovedRenderer | null,
	selection: RuntimeSelection,
): void {
	session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, callback) => {
		const renderer = getRenderer();
		const approved = renderer && !renderer.contents.isDestroyed() && request.webContentsId === renderer.contents.id;
		const appUrl = desktopUrl(request.url);
		const local = Boolean(
			approved && appUrl && (request.initiatorOrigin === undefined || request.initiatorOrigin === DESKTOP_ORIGIN),
		);
		const embedded = Boolean(
			approved && request.initiatorOrigin === DESKTOP_ORIGIN && /^(?:data|blob):/.test(request.url),
		);
		callback({ cancel: !local && !embedded && !isAdmittedSocket(request, renderer, selection) });
	});
	session.webRequest.onBeforeSendHeaders({ urls: ["ws://127.0.0.1/*"] }, (request, callback) => {
		const headers = stripPrivateHeaders(request);
		const selected = selection.get();
		if (!selected || !isAdmittedSocket(request, getRenderer(), selection)) {
			callback({ cancel: true, requestHeaders: headers });
			return;
		}
		headers[DESKTOP_TOKEN_HEADER] = selected.clientToken;
		callback({ requestHeaders: headers });
	});
	session.setPermissionCheckHandler(
		(contents, permission, requestingOrigin, details) =>
			requestingOrigin === DESKTOP_ORIGIN &&
			isAdmittedClipboardPermission(contents, permission, details, getRenderer()),
	);
	session.setPermissionRequestHandler((contents, permission, callback, details) =>
		callback(isAdmittedClipboardPermission(contents, permission, details, getRenderer())),
	);
	session.setDevicePermissionHandler(() => false);
	session.on("will-download", (event) => event.preventDefault());
}

function stripPrivateHeaders(request: OnBeforeSendHeadersListenerDetails): Record<string, string> {
	const blocked = new Set([DESKTOP_TOKEN_HEADER.toLowerCase(), "authorization", "cookie", "proxy-authorization"]);
	return Object.fromEntries(Object.entries(request.requestHeaders).filter(([key]) => !blocked.has(key.toLowerCase())));
}
