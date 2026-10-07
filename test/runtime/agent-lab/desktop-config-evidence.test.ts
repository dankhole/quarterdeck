import { describe, expect, it } from "vitest";

import { readDesktopAgentAvailability } from "../../../scripts/agent-lab/desktop-config-evidence";

describe("desktop config availability evidence", () => {
	it("retains only typed agent availability from successful tRPC envelopes", () => {
		const agent = {
			id: "codex",
			installed: false,
			status: "upgrade_required",
			statusMessage: "Could not determine Codex version.",
			detectedVersion: null,
			requiredVersion: "0.1.0",
			command: "private-command-value",
			defaultArgs: ["private-command-argument"],
		};
		const evidence = readDesktopAgentAvailability([
			{ result: { data: { agents: [agent], apiKey: "private-auth-value", home: "/private/profile" } } },
			{ result: { data: { unrelated: "private-content" } } },
		]);
		expect(evidence).toEqual([
			{
				id: "codex",
				installed: false,
				status: "upgrade_required",
				statusMessage: "Could not determine Codex version.",
				detectedVersion: null,
				requiredVersion: "0.1.0",
			},
		]);
		expect(JSON.stringify(evidence)).not.toContain("private-");
	});

	it("ignores malformed definitions and error envelopes instead of retaining raw bodies", () => {
		expect(readDesktopAgentAvailability({ error: { message: "private error details" } })).toEqual([]);
		expect(readDesktopAgentAvailability({ result: { data: { agents: [{ id: "unknown" }] } } })).toEqual([]);
	});
});
