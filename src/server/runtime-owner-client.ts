import { z } from "zod";
import {
	QUARTERDECK_DESKTOP_BRIDGE_VERSION,
	QUARTERDECK_MANAGEMENT_PROTOCOL_VERSION,
	type RuntimeOwnerDescriptor,
	runtimeManagementHandshakeResponseSchema,
	runtimeManagementProjectOpenResponseSchema,
} from "../core/api/runtime-management.js";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../core/api/runtime-protocol.js";
import { type DiscoveredRuntimeOwner, discoverRuntimeOwner } from "./runtime-ownership.js";

const bootstrapResponseSchema = z.object({ generation: z.string().uuid(), bootstrapPath: z.string() }).strict();
const enrollmentResponseSchema = z.object({ generation: z.string().uuid(), enrolled: z.literal(true) }).strict();
const revocationResponseSchema = z.object({ generation: z.string().uuid(), revoked: z.literal(true) }).strict();

export class RuntimeOwnerConnectionError extends Error {
	constructor(
		readonly code: "incompatible_runtime" | "ownership_unavailable",
		message: string,
	) {
		super(message);
		this.name = "RuntimeOwnerConnectionError";
	}
}

function ownerOrigin(descriptor: RuntimeOwnerDescriptor): string {
	const endpoint = descriptor.endpoint;
	if (!endpoint || !["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", "[::]"].includes(endpoint.host)) {
		throw new Error("The existing runtime does not have a supported loopback endpoint.");
	}
	// A wildcard bind accepts local management; never use the wildcard address as a browser origin.
	const host =
		endpoint.host === "0.0.0.0"
			? "127.0.0.1"
			: ["::", "[::]", "::1"].includes(endpoint.host)
				? "[::1]"
				: endpoint.host;
	return `http://${host}:${endpoint.port}`;
}

async function ownerRequest(descriptor: RuntimeOwnerDescriptor, path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`${ownerOrigin(descriptor)}${path}`, {
		method: body === undefined ? "GET" : "POST",
		redirect: "error",
		headers: {
			authorization: `Bearer ${descriptor.managementToken}`,
			"x-quarterdeck-runtime-generation": descriptor.generation,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(3_000),
	});
	if (!response.ok) throw new Error(`Existing runtime management request failed (${response.status}).`);
	return await response.json();
}

/** A live owner can be starting; wait for its descriptor, never start another writer. */
export async function waitForReadyRuntimeOwner(owner: DiscoveredRuntimeOwner): Promise<RuntimeOwnerDescriptor> {
	const deadline = Date.now() + 15_000;
	let current: DiscoveredRuntimeOwner | null = owner;
	while (current?.claim.generation === owner.claim.generation && !current.released) {
		if (current.claim.purpose !== "runtime")
			throw new RuntimeOwnerConnectionError(
				"ownership_unavailable",
				"State maintenance is active. Retry after it finishes.",
			);
		if (current.descriptor?.status === "ready") return current.descriptor;
		if (current.descriptor?.status === "stopping")
			throw new RuntimeOwnerConnectionError(
				"ownership_unavailable",
				"The existing runtime is stopping. Retry after it exits.",
			);
		if (Date.now() >= deadline) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		current = await discoverRuntimeOwner(owner.claim.canonicalStateHome);
	}
	throw new RuntimeOwnerConnectionError(
		"ownership_unavailable",
		"The existing runtime is not ready. Check its diagnostics or wait for it to finish starting.",
	);
}

export async function verifyRuntimeOwner(descriptor: RuntimeOwnerDescriptor, desktop: boolean): Promise<string> {
	if (
		descriptor.managementProtocolVersion !== QUARTERDECK_MANAGEMENT_PROTOCOL_VERSION ||
		descriptor.runtimeProtocolVersion !== QUARTERDECK_RUNTIME_PROTOCOL_VERSION ||
		descriptor.capabilities.transportVersion !== 1 ||
		!descriptor.capabilities.browserHttp ||
		!descriptor.capabilities.browserWebSocket ||
		(desktop &&
			(!descriptor.capabilities.desktopProxy ||
				descriptor.capabilities.desktopBridgeVersion !== QUARTERDECK_DESKTOP_BRIDGE_VERSION))
	)
		throw new RuntimeOwnerConnectionError(
			"incompatible_runtime",
			"The existing runtime needs to be restarted with a compatible Quarterdeck version.",
		);
	if (desktop && descriptor.endpoint?.host !== "127.0.0.1") {
		throw new Error("Desktop attachment requires a runtime bound to 127.0.0.1.");
	}
	const { descriptor: verified } = runtimeManagementHandshakeResponseSchema.parse(
		await ownerRequest(descriptor, "/api/management/status"),
	);
	if (
		verified.generation !== descriptor.generation ||
		verified.canonicalStateHome !== descriptor.canonicalStateHome ||
		verified.process.pid !== descriptor.process.pid ||
		verified.process.creationIdentity !== descriptor.process.creationIdentity ||
		verified.status !== "ready" ||
		verified.runtimeProtocolVersion !== descriptor.runtimeProtocolVersion ||
		JSON.stringify(verified.capabilities) !== JSON.stringify(descriptor.capabilities) ||
		verified.endpoint?.host !== descriptor.endpoint?.host ||
		verified.endpoint?.port !== descriptor.endpoint?.port
	)
		throw new Error("The existing runtime identity changed during attachment. Retry the launch.");
	return ownerOrigin(descriptor);
}

export async function enrollDesktopClient(descriptor: RuntimeOwnerDescriptor, clientToken: string): Promise<void> {
	const result = enrollmentResponseSchema.parse(
		await ownerRequest(descriptor, "/api/management/client-bootstrap", {
			generation: descriptor.generation,
			kind: "desktop",
			clientToken,
			origin: "app://quarterdeck",
		}),
	);
	if (result.generation !== descriptor.generation) throw new Error("Runtime generation changed during attachment.");
}

export async function revokeDesktopClient(descriptor: RuntimeOwnerDescriptor, clientToken: string): Promise<void> {
	const result = revocationResponseSchema.parse(
		await ownerRequest(descriptor, "/api/management/client-revoke", {
			generation: descriptor.generation,
			kind: "desktop",
			clientToken,
		}),
	);
	if (result.generation !== descriptor.generation) throw new Error("Runtime generation changed during detachment.");
}

export async function createOwnerBrowserBootstrap(
	descriptor: RuntimeOwnerDescriptor,
	returnPath = "/",
): Promise<string> {
	const result = bootstrapResponseSchema.parse(
		await ownerRequest(descriptor, "/api/management/client-bootstrap", {
			generation: descriptor.generation,
			kind: "browser",
			returnPath,
		}),
	);
	if (
		result.generation !== descriptor.generation ||
		!result.bootstrapPath.startsWith("/api/runtime/client-bootstrap?")
	) {
		throw new Error("Invalid browser launch response from existing runtime.");
	}
	const origin = ownerOrigin(descriptor);
	const url = new URL(result.bootstrapPath, origin);
	if (url.origin !== origin) throw new Error("Invalid browser launch origin.");
	return url.href;
}

export async function openOwnerProject(descriptor: RuntimeOwnerDescriptor, projectPath: string): Promise<string> {
	const result = runtimeManagementProjectOpenResponseSchema.parse(
		await ownerRequest(descriptor, "/api/management/projects/open", {
			generation: descriptor.generation,
			projectPath,
		}),
	);
	return result.projectId;
}
