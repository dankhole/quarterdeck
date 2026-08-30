import { describe, expect, it } from "vitest";

import { mergeProcessEnvironment } from "../../../src/core/process-environment";

describe("mergeProcessEnvironment", () => {
	it("applies Windows overrides without retaining case aliases", () => {
		const result = mergeProcessEnvironment(
			{ Path: "C:\\host", SystemRoot: "C:\\Windows" },
			{ PATH: "C:\\task", SYSTEMROOT: undefined },
			"win32",
		);

		expect(result).toEqual({ PATH: "C:\\task" });
	});

	it("preserves case-distinct keys on POSIX", () => {
		expect(mergeProcessEnvironment({ Path: "/host" }, { PATH: "/task" }, "linux")).toEqual({
			Path: "/host",
			PATH: "/task",
		});
	});
});
