import { describe, expect, it } from "vitest";
import { resolveRuntimeProtocolCompatibility } from "@/runtime/runtime-protocol-compatibility";

describe("resolveRuntimeProtocolCompatibility", () => {
	it("accepts the same protocol independently of build identity or storage", () => {
		expect(resolveRuntimeProtocolCompatibility(1, 1)).toBe("compatible");
	});

	it.each([undefined, null, "1", 0, -1, 1.5, {}, Number.NaN, Number.POSITIVE_INFINITY])(
		"blocks an unknown or malformed protocol without an automatic reload: %j",
		(runtimeProtocolVersion) => {
			expect(resolveRuntimeProtocolCompatibility(runtimeProtocolVersion, 1)).toBe("blocked");
		},
	);

	it.each([
		[1, 2],
		[2, 1],
	])("blocks incompatible runtime %i / renderer %i immediately", (runtimeVersion, rendererVersion) => {
		expect(resolveRuntimeProtocolCompatibility(runtimeVersion, rendererVersion)).toBe("blocked");
	});
});
