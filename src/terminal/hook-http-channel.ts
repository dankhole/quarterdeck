import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
	type HookRuntimeContext,
	QUARTERDECK_HOOK_PROJECT_ID_ENV,
	QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV,
	QUARTERDECK_HOOK_TASK_ID_ENV,
} from "./hook-runtime-context";

/**
 * Best-effort native hook delivery over loopback HTTP.
 *
 * A provider that can POST hook payloads itself (Claude `type: "http"` hooks)
 * avoids spawning a `hooks notify` process per event. The channel only carries
 * best-effort activity; reliable transitions keep the CLI's durable outbox.
 *
 * The provider learns the endpoint URL from the launch settings file, but the
 * URL never carries a credential. Identity and the credential reach the request
 * through headers the provider interpolates from the launch environment. The
 * credential is an HMAC of that exact task-session identity under a secret that
 * exists only in this runtime process, so it cannot be replayed for another
 * task, another launch, or another runtime that later reuses the port.
 */
export const HOOK_HTTP_NOTIFY_PATH = "/api/hooks/notify";
export const QUARTERDECK_HOOK_HTTP_TOKEN_ENV = "QUARTERDECK_HOOK_HTTP_TOKEN";

export const HOOK_HTTP_TOKEN_HEADER = "x-quarterdeck-hook-token";
export const HOOK_HTTP_TASK_ID_HEADER = "x-quarterdeck-hook-task-id";
export const HOOK_HTTP_PROJECT_ID_HEADER = "x-quarterdeck-hook-project-id";
export const HOOK_HTTP_SESSION_INSTANCE_ID_HEADER = "x-quarterdeck-hook-session-instance-id";

const CREDENTIAL_DOMAIN = "quarterdeck-hook-http-notify-v1";
const SECRET_BYTES = 32;

/** Header templates for a provider that interpolates allowlisted environment variables. */
export interface HookHttpTransport {
	url: string;
	headers: Record<string, string>;
	allowedEnvVars: string[];
}

export interface HookHttpLaunch {
	transport: HookHttpTransport;
	env: Record<string, string>;
}

const HEADER_ENV_BINDINGS: ReadonlyArray<readonly [header: string, envName: string]> = [
	[HOOK_HTTP_TOKEN_HEADER, QUARTERDECK_HOOK_HTTP_TOKEN_ENV],
	[HOOK_HTTP_TASK_ID_HEADER, QUARTERDECK_HOOK_TASK_ID_ENV],
	[HOOK_HTTP_PROJECT_ID_HEADER, QUARTERDECK_HOOK_PROJECT_ID_ENV],
	[HOOK_HTTP_SESSION_INSTANCE_ID_HEADER, QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV],
];

function credentialMessage(context: HookRuntimeContext): string {
	return JSON.stringify([
		CREDENTIAL_DOMAIN,
		context.projectId,
		context.taskId,
		context.sessionInstanceId?.trim() || "",
	]);
}

/**
 * Per-runtime-process hook HTTP channel. The runtime publishes the loopback
 * endpoint only after it is listening and withdraws it before closing; while
 * unpublished, launches fall back to command hooks.
 */
export class HookHttpChannel {
	private readonly secret: Buffer;
	private notifyUrl: string | null = null;

	constructor(secret: Buffer = randomBytes(SECRET_BYTES)) {
		if (secret.length < SECRET_BYTES) {
			throw new Error("Hook HTTP channel secret is too short.");
		}
		this.secret = Buffer.from(secret);
	}

	publishEndpoint(origin: string): void {
		this.notifyUrl = new URL(HOOK_HTTP_NOTIFY_PATH, origin).toString();
	}

	withdrawEndpoint(): void {
		this.notifyUrl = null;
	}

	getNotifyUrl(): string | null {
		return this.notifyUrl;
	}

	mintCredential(context: HookRuntimeContext): string {
		return createHmac("sha256", this.secret).update(credentialMessage(context)).digest("base64url");
	}

	verifyCredential(context: HookRuntimeContext, credential: string | undefined): boolean {
		if (!credential) {
			return false;
		}
		const expected = Buffer.from(this.mintCredential(context));
		const actual = Buffer.from(credential);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	/**
	 * Returns the provider transport and launch env, or null when command hooks
	 * must be used. `inheritedEnv` is the environment the provider would
	 * otherwise receive; its proxy bypass list is extended, never replaced.
	 */
	prepareLaunch(
		context: HookRuntimeContext,
		inheritedEnv: Readonly<NodeJS.ProcessEnv> = process.env,
	): HookHttpLaunch | null {
		if (!this.notifyUrl) {
			return null;
		}
		return {
			transport: {
				url: this.notifyUrl,
				headers: Object.fromEntries(HEADER_ENV_BINDINGS.map(([header, envName]) => [header, `\${${envName}}`])),
				allowedEnvVars: HEADER_ENV_BINDINGS.map(([, envName]) => envName),
			},
			env: {
				...buildLoopbackProxyBypassEnv(inheritedEnv),
				[QUARTERDECK_HOOK_HTTP_TOKEN_ENV]: this.mintCredential(context),
			},
		};
	}
}

const LOOPBACK_NO_PROXY_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * Keeps an inherited HTTP(S) proxy from intercepting the loopback hook POST.
 * Tools disagree on whether `NO_PROXY` or `no_proxy` wins, so both receive the
 * union of their existing entries plus loopback; entries are only ever added.
 */
export function buildLoopbackProxyBypassEnv(inheritedEnv: Readonly<NodeJS.ProcessEnv>): {
	NO_PROXY: string;
	no_proxy: string;
} {
	const entries: string[] = [];
	for (const value of [inheritedEnv.NO_PROXY, inheritedEnv.no_proxy]) {
		for (const entry of value?.split(",") ?? []) {
			const trimmed = entry.trim();
			if (trimmed && !entries.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
				entries.push(trimmed);
			}
		}
	}
	for (const host of LOOPBACK_NO_PROXY_HOSTS) {
		if (!entries.some((existing) => existing.toLowerCase() === host)) entries.push(host);
	}
	const value = entries.join(",");
	return { NO_PROXY: value, no_proxy: value };
}

let activeChannel: HookHttpChannel | null = null;

/** The runtime process owns at most one published channel; launches read it at preparation time. */
export function setActiveHookHttpChannel(channel: HookHttpChannel | null): void {
	activeChannel = channel;
}

export function getActiveHookHttpChannel(): HookHttpChannel | null {
	return activeChannel;
}
