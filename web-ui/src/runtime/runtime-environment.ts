import {
	type DesktopBridge,
	type DesktopCapabilities,
	QUARTERDECK_DESKTOP_BRIDGE_VERSION,
} from "../../../src/shared/desktop-bridge-contract";

declare global {
	interface Window {
		readonly quarterdeckDesktop?: DesktopBridge;
	}
}

export type RuntimeWebSocketPath = "/api/runtime/ws" | "/api/terminal/io" | "/api/terminal/control";

export type RuntimeEnvironment =
	| { readonly kind: "browser"; readonly runtimeOrigin: string }
	| {
			readonly kind: "desktop";
			readonly runtimeOrigin: string;
			readonly runtimeGeneration: string;
			readonly capabilities: DesktopCapabilities;
	  };

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function invalidDesktopEnvironment(): never {
	// Never include bridge data or endpoint values in errors or diagnostic messages.
	throw new Error("Desktop runtime bootstrap is invalid or unsupported. Restart Quarterdeck.");
}

function hasDesktopBridgeKeys(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const optionalMethods = [
		"onCommand",
		"onOpenProject",
		"publishCommandAvailability",
		"onNotificationTarget",
		"reportNotificationContext",
		"onQuitPreflight",
		"respondQuitPreflight",
		"saveEditorDraft",
		"onPreflightReleased",
	];
	return (
		Object.hasOwn(value, "version") &&
		Object.hasOwn(value, "bootstrap") &&
		Object.keys(value).every(
			(key) =>
				key === "version" ||
				key === "bootstrap" ||
				(optionalMethods.includes(key) && typeof (value as Record<string, unknown>)[key] === "function"),
		)
	);
}

/** Browser clients keep their HTTP origin; desktop clients require the pinned preload endpoint. */
export function resolveRuntimeEnvironment(
	location: Pick<Location, "protocol" | "host">,
	desktopBridge: unknown,
): RuntimeEnvironment {
	if (desktopBridge !== undefined) {
		if (
			location.protocol !== "app:" ||
			location.host !== "quarterdeck" ||
			!hasDesktopBridgeKeys(desktopBridge) ||
			desktopBridge.version !== QUARTERDECK_DESKTOP_BRIDGE_VERSION
		) {
			return invalidDesktopEnvironment();
		}
		const bootstrap = desktopBridge.bootstrap;
		if (!hasExactKeys(bootstrap, ["runtimeOrigin", "runtimeGeneration", "capabilities"])) {
			return invalidDesktopEnvironment();
		}
		const capabilities = bootstrap.capabilities;
		if (
			!hasExactKeys(capabilities, ["desktop", "nativeDialogs", "nativeNotifications"]) ||
			capabilities.desktop !== true ||
			typeof capabilities.nativeDialogs !== "boolean" ||
			typeof capabilities.nativeNotifications !== "boolean" ||
			typeof bootstrap.runtimeGeneration !== "string" ||
			!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(bootstrap.runtimeGeneration) ||
			typeof bootstrap.runtimeOrigin !== "string"
		) {
			return invalidDesktopEnvironment();
		}
		// Use the helper's canonical IPv4 loopback endpoint. Reject alternate host spellings,
		// credentials, paths, query strings and fragments before URL normalization.
		const endpoint = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(bootstrap.runtimeOrigin);
		if (!endpoint || Number(endpoint[1]) > 65_535) {
			return invalidDesktopEnvironment();
		}
		return {
			kind: "desktop",
			runtimeOrigin: new URL(bootstrap.runtimeOrigin).origin,
			runtimeGeneration: bootstrap.runtimeGeneration,
			capabilities: {
				desktop: true,
				nativeDialogs: capabilities.nativeDialogs,
				nativeNotifications: capabilities.nativeNotifications,
			},
		};
	}

	if (location.protocol !== "http:" && location.protocol !== "https:") {
		throw new Error("Runtime transport requires an HTTP origin or a valid desktop bootstrap.");
	}
	return { kind: "browser", runtimeOrigin: new URL(`${location.protocol}//${location.host}`).origin };
}

export function getRuntimeEnvironment(): RuntimeEnvironment {
	return resolveRuntimeEnvironment(window.location, window.quarterdeckDesktop);
}

/** All runtime socket URLs share the same validated environment. No credentials are added here. */
export function getRuntimeWebSocketUrl(path: RuntimeWebSocketPath): URL {
	const url = new URL(path, getRuntimeEnvironment().runtimeOrigin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url;
}
