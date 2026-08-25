import { describe, expect, it } from "vitest";

import { _testing } from "../../../scripts/agent-lab/browser-actions";

describe("Agent Lab browser action lifecycle fence", () => {
	it("allows ordinary commands only while the run can own browser activity", () => {
		expect(_testing.isAgentBrowserActionAllowed({ status: "ready" }, "open")).toBe(true);
		expect(_testing.isAgentBrowserActionAllowed({ status: "restarting" }, "snapshot")).toBe(true);
		expect(_testing.isAgentBrowserActionAllowed({ status: "stopping" }, "open")).toBe(false);
		expect(_testing.isAgentBrowserActionAllowed({ status: "stopped" }, "snapshot")).toBe(false);
		expect(_testing.isAgentBrowserActionAllowed({ status: "failed" }, "open")).toBe(false);
		expect(_testing.isAgentBrowserActionAllowed({ status: "stopping" }, "close")).toBe(true);
	});
});
