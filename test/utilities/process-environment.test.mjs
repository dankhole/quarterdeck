import { describe, expect, it } from "vitest";

import {
	getProcessEnvironmentValue,
	mergeProcessEnvironment,
} from "../../scripts/process-environment.mjs";

describe("script process environment", () => {
	it("reads and replaces Windows key aliases case-insensitively", () => {
		expect(getProcessEnvironmentValue({ Node_Env: "test" }, "NODE_ENV", "win32")).toBe("test");
		expect(
			mergeProcessEnvironment(
				{ Path: "C:\\host", quarterdeck_state_home: "C:\\old" },
				{ PATH: "C:\\isolated", QUARTERDECK_STATE_HOME: "C:\\new" },
				"win32",
			),
		).toEqual({ PATH: "C:\\isolated", QUARTERDECK_STATE_HOME: "C:\\new" });
	});

	it("preserves POSIX case distinctions", () => {
		expect(mergeProcessEnvironment({ Path: "/one" }, { PATH: "/two" }, "linux")).toEqual({
			Path: "/one",
			PATH: "/two",
		});
	});
});
