import { beforeEach, describe, expect, it } from "vitest";
import { resolveRuntimeProtocolCompatibility } from "@/runtime/runtime-protocol-compatibility";

const getStorage = () => sessionStorage;

describe("resolveRuntimeProtocolCompatibility", () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it("accepts the same protocol and clears a previous reload fence", () => {
		expect(resolveRuntimeProtocolCompatibility(2, 1, getStorage)).toBe("reload");
		expect(resolveRuntimeProtocolCompatibility(1, 1, getStorage)).toBe("compatible");
		expect(resolveRuntimeProtocolCompatibility(2, 1, getStorage)).toBe("reload");
	});

	it.each([undefined, null, "1", 0, -1, 1.5, {}, Number.NaN, Number.POSITIVE_INFINITY])(
		"reloads once then blocks an unknown or malformed protocol: %j",
		(runtimeProtocolVersion) => {
			expect(resolveRuntimeProtocolCompatibility(runtimeProtocolVersion, 1, getStorage)).toBe("reload");
			expect(resolveRuntimeProtocolCompatibility(runtimeProtocolVersion, 1, getStorage)).toBe("blocked");
		},
	);

	it.each([
		[1, 2],
		[2, 1],
	])("reloads once then blocks incompatible runtime %i / browser %i", (runtimeVersion, browserVersion) => {
		expect(resolveRuntimeProtocolCompatibility(runtimeVersion, browserVersion, getStorage)).toBe("reload");
		expect(resolveRuntimeProtocolCompatibility(runtimeVersion, browserVersion, getStorage)).toBe("blocked");
	});

	it("allows a changed protocol pair to trigger a new bounded reload", () => {
		expect(resolveRuntimeProtocolCompatibility(2, 1, getStorage)).toBe("reload");
		expect(resolveRuntimeProtocolCompatibility(3, 1, getStorage)).toBe("reload");
		expect(resolveRuntimeProtocolCompatibility(3, 2, getStorage)).toBe("reload");
	});

	it.each(["access", "read", "write"])(
		"does not depend on storage for compatibility or loop when storage %s fails",
		(failure) => {
			const unavailableStorage = () => {
				if (failure === "access") throw new Error("blocked");
				return {
					getItem: (key: string) => {
						if (failure === "read") throw new Error("blocked");
						return sessionStorage.getItem(key);
					},
					setItem: (key: string, value: string) => {
						if (failure === "write") throw new Error("blocked");
						sessionStorage.setItem(key, value);
					},
					removeItem: (key: string) => sessionStorage.removeItem(key),
				};
			};
			expect(resolveRuntimeProtocolCompatibility(2, 1, unavailableStorage)).toBe("blocked");
			expect(resolveRuntimeProtocolCompatibility(1, 1, unavailableStorage)).toBe("compatible");
		},
	);

	it("accepts compatible peers and still bounds reloads when only storage removal fails", () => {
		const storageWithFailedRemoval = () => ({
			getItem: (key: string) => sessionStorage.getItem(key),
			setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
			removeItem: () => {
				throw new Error("blocked");
			},
		});

		expect(resolveRuntimeProtocolCompatibility(1, 1, storageWithFailedRemoval)).toBe("compatible");
		expect(resolveRuntimeProtocolCompatibility(2, 1, storageWithFailedRemoval)).toBe("reload");
		expect(resolveRuntimeProtocolCompatibility(2, 1, storageWithFailedRemoval)).toBe("blocked");
	});
});
