import { describe, expect, it } from "vitest";
import {
	cloneStartTaskSessionRequest,
	type StartTaskSessionRequest,
} from "../../../src/terminal/session-manager-types.js";

describe("Pi session launch request", () => {
	it("freezes the selected model independently for later launch/restart", () => {
		const request: StartTaskSessionRequest = {
			taskId: "pi-task",
			agentId: "pi",
			binary: "pi",
			args: [],
			cwd: "/project",
			prompt: "Task",
			piOptions: { model: { provider: "alpha", id: "chosen" } },
		};
		const frozen = cloneStartTaskSessionRequest(request);
		if (!request.piOptions?.model) throw new Error("Missing fixture model");
		request.piOptions.model.id = "mutated";
		expect(frozen.piOptions).toEqual({ model: { provider: "alpha", id: "chosen" } });
	});
});
