import { getRuntimeWebSocketUrl } from "@/runtime/runtime-environment";

export function generateTerminalClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `terminal-${Math.random().toString(36).slice(2, 10)}`;
}

export function getTerminalWebSocketUrl(
	path: "io" | "control",
	taskId: string,
	projectId: string,
	clientId: string,
): string {
	const url = getRuntimeWebSocketUrl(`/api/terminal/${path}`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("projectId", projectId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

export function decodeTerminalSocketChunk(decoder: TextDecoder, data: string | ArrayBuffer | Blob): string {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return decoder.decode(new Uint8Array(data), { stream: true });
	}
	return "";
}

export function getTerminalSocketWriteData(data: string | ArrayBuffer | Blob): string | Uint8Array | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return null;
}

export function getTerminalSocketChunkByteLength(data: string | ArrayBuffer | Blob): number {
	if (typeof data === "string") {
		return new TextEncoder().encode(data).byteLength;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	return 0;
}
