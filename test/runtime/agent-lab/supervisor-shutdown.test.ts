import { describe, expect, it } from "vitest";

import { executeAgentLabShutdownSequence } from "../../../scripts/agent-lab/supervisor";

describe("Agent Lab supervisor shutdown", () => {
	it("captures final evidence only after children stop and the manifest is finalized", async () => {
		const steps: string[] = [];
		const action = (name: string) => async (): Promise<void> => {
			steps.push(name);
		};

		await executeAgentLabShutdownSequence({
			capturePreShutdown: action("capture-pre-shutdown"),
			closeBrowser: action("close-browser"),
			stopChildren: action("stop-children"),
			finalizeManifest: action("finalize-manifest"),
			captureFinal: action("capture-final"),
			removeTemporaryFixture: action("remove-temporary-fixture"),
		});

		expect(steps).toEqual([
			"capture-pre-shutdown",
			"close-browser",
			"stop-children",
			"finalize-manifest",
			"capture-final",
			"remove-temporary-fixture",
		]);
	});
});
