import { isProductPage } from "./security-policy.js";

/** The document identity and messaging surface needed by native command orchestration. */
export interface RendererDocumentContents {
	readonly mainFrame: { readonly url: string };
	isDestroyed(): boolean;
	getURL(): string;
	send(channel: string, payload: unknown): void;
}

export interface ApprovedRendererDocument {
	contents: RendererDocumentContents;
	generation: string | null;
	documentId?: string | null;
}

export interface RendererDocumentEvent {
	sender: RendererDocumentContents;
	senderFrame: { readonly url: string } | null;
}

/** Recovery saves/preflight remain available to the surviving document after runtime authority is revoked. */
export function isApprovedDocumentSender(
	event: RendererDocumentEvent,
	renderer: ApprovedRendererDocument | null,
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
