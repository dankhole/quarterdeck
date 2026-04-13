export async function requestJson<T>(input: {
	baseUrl: string;
	procedure: string;
	type: "query" | "mutation";
	workspaceId?: string | null;
	payload?: unknown;
}): Promise<{ status: number; payload: T }> {
	const unwrapTrpcPayload = (value: unknown): unknown => {
		const envelope = Array.isArray(value) ? value[0] : value;
		if (!envelope || typeof envelope !== "object") {
			return value;
		}
		if ("result" in envelope) {
			const result = (envelope as { result?: { data?: unknown } }).result;
			const data = result?.data;
			if (data && typeof data === "object" && "json" in data) {
				return (data as { json: unknown }).json;
			}
			return data;
		}
		if ("error" in envelope) {
			return (envelope as { error: unknown }).error;
		}
		return value;
	};
	const headers = new Headers();
	if (input.workspaceId) {
		headers.set("x-quarterdeck-workspace-id", input.workspaceId);
	}
	let url = `${input.baseUrl}/api/trpc/${input.procedure}`;
	let method: "GET" | "POST";
	let body: string | undefined;
	if (input.type === "query") {
		method = "GET";
		if (input.payload !== undefined) {
			url += `?input=${encodeURIComponent(JSON.stringify(input.payload))}`;
		}
	} else {
		method = "POST";
		body = input.payload === undefined ? undefined : JSON.stringify(input.payload);
	}
	if (body !== undefined) {
		headers.set("Content-Type", "application/json");
	}
	const response = await fetch(url, {
		method,
		headers,
		body,
	});
	const payload = unwrapTrpcPayload(await response.json().catch(() => null)) as T;
	return {
		status: response.status,
		payload,
	};
}
