import type {
	IpcMainEvent,
	OnBeforeRequestListenerDetails,
	OnBeforeSendHeadersListenerDetails,
	PermissionCheckHandlerHandlerDetails,
	PermissionRequest,
	Session,
	WebContents,
} from "electron";
import { type ApprovedRendererDocument, isApprovedDocumentSender } from "./renderer-document.js";
import type { RuntimeSelection } from "./runtime-selection.js";

export { DESKTOP_BOOTSTRAP_CHANNEL } from "./desktop-ipc-channels.js";
export { isApprovedDocumentSender } from "./renderer-document.js";

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

export interface ApprovedRenderer extends ApprovedRendererDocument {
	contents: WebContents;
	role?: "compare";
	/** Main-created, immutable destination for the transport-only Compare role. */
	documentUrl?: string;
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
			isPinnedWebSocket(request.url, runtime.origin) &&
			(renderer.role !== "compare" ||
				(Boolean(renderer.documentId) &&
					renderer.contents.mainFrame.url === renderer.documentUrl &&
					new URL(request.url).pathname === "/api/runtime/ws")),
	);
}

export function isBootstrapSender(
	event: Pick<IpcMainEvent, "sender" | "senderFrame">,
	renderer: ApprovedRenderer | null,
	selection: RuntimeSelection,
): boolean {
	return (
		isApprovedDocumentSender(event, renderer, renderer?.generation ?? null) &&
		Boolean(selection.get() && renderer?.generation === selection.get()?.generation) &&
		(renderer?.role !== "compare" || renderer.contents.mainFrame.url === renderer.documentUrl)
	);
}

export function installRendererAdmission(
	session: Session,
	getRenderer: (contentsId?: number) => ApprovedRenderer | null,
	selection: RuntimeSelection,
): void {
	session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, callback) => {
		const renderer = getRenderer(request.webContentsId);
		const approved = renderer && !renderer.contents.isDestroyed() && request.webContentsId === renderer.contents.id;
		if (renderer?.role === "compare" && !isAdmittedCompareRequest(request, renderer, selection)) {
			callback({ cancel: true });
			return;
		}
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
		if (!selected || !isAdmittedSocket(request, getRenderer(request.webContentsId), selection)) {
			callback({ cancel: true, requestHeaders: headers });
			return;
		}
		headers[DESKTOP_TOKEN_HEADER] = selected.clientToken;
		callback({ requestHeaders: headers });
	});
	session.setPermissionCheckHandler(
		(contents, permission, requestingOrigin, details) =>
			requestingOrigin === DESKTOP_ORIGIN &&
			isAdmittedClipboardPermission(contents, permission, details, getRenderer(contents?.id)),
	);
	session.setPermissionRequestHandler((contents, permission, callback, details) =>
		callback(isAdmittedClipboardPermission(contents, permission, details, getRenderer(contents?.id))),
	);
	session.setDevicePermissionHandler(() => false);
	session.on("will-download", (event) => event.preventDefault());
}

/** A Compare document can read runtime data, but cannot launch/control terminals or mutate project state. */
export function isAdmittedCompareRequest(
	request: Pick<OnBeforeRequestListenerDetails, "url" | "method" | "resourceType" | "frame">,
	renderer: ApprovedRenderer,
	selection: RuntimeSelection,
): boolean {
	if (!renderer.documentId || renderer.generation !== selection.get()?.generation || !selection.get()) return false;
	if (request.resourceType === "mainFrame") return request.method === "GET" && request.url === renderer.documentUrl;
	if (request.frame !== renderer.contents.mainFrame || renderer.contents.mainFrame.url !== renderer.documentUrl)
		return false;
	if (request.resourceType === "webSocket") return new URL(request.url).pathname === "/api/runtime/ws";
	if (request.method === "GET" || request.method === "HEAD") return true;
	const url = desktopUrl(request.url);
	const navigationProcedures =
		url?.pathname.startsWith("/api/trpc/") && url.pathname.length <= 1024
			? url.pathname.slice("/api/trpc/".length).split(",")
			: [];
	const navigationReads =
		navigationProcedures.length > 0 &&
		navigationProcedures.length <= 16 &&
		navigationProcedures.every((procedure) =>
			[
				"project.codeNavigation.definition",
				"project.codeNavigation.references",
				"project.codeNavigation.hover",
			].includes(procedure),
		);
	return (
		request.method === "POST" &&
		url !== null &&
		// Match literal canonical paths; only bounded batches containing exclusively navigation reads are safe.
		request.url === `${DESKTOP_ORIGIN}${url.pathname}${url.search}` &&
		(navigationReads ||
			new Set([
				"/api/diagnostics/browser-records",
				"/api/diagnostics/browser-snapshot",
				"/api/diagnostics/browser-subscription",
				"/api/diagnostics/browser-record",
			]).has(url.pathname))
	);
}

function stripPrivateHeaders(request: OnBeforeSendHeadersListenerDetails): Record<string, string> {
	const blocked = new Set([DESKTOP_TOKEN_HEADER.toLowerCase(), "authorization", "cookie", "proxy-authorization"]);
	return Object.fromEntries(Object.entries(request.requestHeaders).filter(([key]) => !blocked.has(key.toLowerCase())));
}
