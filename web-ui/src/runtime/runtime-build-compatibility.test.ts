import { beforeEach, describe, expect, it } from "vitest";
import { resolveRuntimeBuildCompatibility } from "@/runtime/runtime-build-compatibility";

describe("resolveRuntimeBuildCompatibility", () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it("accepts a matching runtime and clears a previous reload fence", () => {
		sessionStorage.setItem("quarterdeck.runtime-build-reload.v1", "old-attempt");

		expect(resolveRuntimeBuildCompatibility("build-a", "build-a", sessionStorage)).toBe("compatible");
		expect(sessionStorage.getItem("quarterdeck.runtime-build-reload.v1")).toBeNull();
	});

	it("reloads once and then blocks a runtime that predates build identity", () => {
		expect(resolveRuntimeBuildCompatibility(undefined, "build-a", sessionStorage)).toBe("reload");
		expect(resolveRuntimeBuildCompatibility(undefined, "build-a", sessionStorage)).toBe("blocked");
	});

	it("requests exactly one reload for a mismatched artifact pair", () => {
		expect(resolveRuntimeBuildCompatibility("build-b", "build-a", sessionStorage)).toBe("reload");
		expect(resolveRuntimeBuildCompatibility("build-b", "build-a", sessionStorage)).toBe("blocked");
	});

	it("allows a later runtime build to trigger a new bounded reload", () => {
		expect(resolveRuntimeBuildCompatibility("build-b", "build-a", sessionStorage)).toBe("reload");
		expect(resolveRuntimeBuildCompatibility("build-c", "build-a", sessionStorage)).toBe("reload");
	});

	it("fails closed instead of looping when the reload fence cannot be persisted", () => {
		const unavailableStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};

		expect(resolveRuntimeBuildCompatibility("build-b", "build-a", unavailableStorage)).toBe("blocked");
		expect(resolveRuntimeBuildCompatibility("build-a", "build-a", unavailableStorage)).toBe("compatible");
	});
});
