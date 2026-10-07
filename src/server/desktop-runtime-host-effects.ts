import type { DesktopHostEffectAction, DesktopHostEffectResult } from "../core/api/desktop-runtime-protocol.js";
import type { CreateRuntimeHostIntegrationsOptions } from "./runtime-host-integrations.js";

export type DesktopHostEffectRequest = (
	action: DesktopHostEffectAction,
	runtimeGeneration: string,
) => Promise<DesktopHostEffectResult>;

function failure(result: DesktopHostEffectResult): Error {
	const reason = result.status === "failed" ? result.reason : "denied";
	const error = new Error(`The native desktop host effect could not complete (${reason}).`);
	if (reason === "unavailable" || reason === "disconnected" || reason === "denied")
		Object.assign(error, { code: "ENOENT" });
	return error;
}

/** Inject below IRuntimeHostIntegrations; its authoritative capability checks stay intact. */
export function createDesktopRuntimeHostEffects(
	request: DesktopHostEffectRequest,
	runtimeGeneration: string,
): Pick<CreateRuntimeHostIntegrationsOptions, "pickDirectory" | "openTarget" | "openProject"> {
	return {
		pickDirectory: async () => {
			const result = await request({ method: "pick-directory" }, runtimeGeneration);
			if (result.status === "selected") return { kind: "selected", path: result.path };
			if (result.status === "cancelled") return { kind: "cancelled" };
			if (result.status === "failed" && ["unavailable", "denied", "disconnected"].includes(result.reason)) {
				return { kind: "unavailable", error: failure(result).message };
			}
			throw failure(result);
		},
		openTarget: async (target) => {
			const action: DesktopHostEffectAction = target.startsWith("/")
				? { method: "open-path", path: target }
				: { method: "open-external-url", url: target };
			const result = await request(action, runtimeGeneration);
			if (result.status !== "opened") throw failure(result);
		},
		openProject: async (targetId, path) => {
			const result = await request({ method: "open-project", targetId, path }, runtimeGeneration);
			if (result.status === "opened") return { kind: "opened" };
			return {
				kind:
					result.status === "failed" && ["unavailable", "denied", "disconnected"].includes(result.reason)
						? "unavailable"
						: "failed",
				error: failure(result).message,
			};
		},
	};
}
