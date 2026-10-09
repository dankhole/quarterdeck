import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ events: [], failure: false }));
vi.mock("../scripts/process.mjs", () => ({
	run: (_command, args) => {
		state.events.push({ kind: args.includes("--sign") ? "sign" : "verify", path: args.at(-1) });
		if (state.failure) throw new Error("Invalid signature");
	},
}));
vi.mock("../scripts/release-policy.mjs", () => ({
	releaseBuildSettings: () => ({ signedDistribution: false }),
}));
vi.mock("../scripts/artifact-manifest.mjs", () => ({
	recordPackagedApp: async (path) => {
		state.events.push({ kind: "record", path });
	},
	recordMakeArtifacts: vi.fn(),
}));

import forgeConfig from "../forge.config.mjs";
import { verifyApp } from "../scripts/verify-artifact.mjs";

beforeEach(() => {
	state.events.length = 0;
	state.failure = false;
});

describe("packaged signature admission", () => {
	it("reseals each finished local app before recording its artifact", async () => {
		await forgeConfig.hooks.postPackage({}, { outputPaths: ["/first", "/second"], arch: process.arch });
		expect(state.events).toEqual([
			{ kind: "sign", path: "/first/Quarterdeck.app" },
			{ kind: "record", path: "/first" },
			{ kind: "sign", path: "/second/Quarterdeck.app" },
			{ kind: "record", path: "/second" },
		]);
	});

	it("does not record an app when final signing fails", async () => {
		state.failure = true;
		await expect(
			forgeConfig.hooks.postPackage({}, { outputPaths: ["/candidate"], arch: process.arch }),
		).rejects.toThrow("Invalid signature");
		expect(state.events).toEqual([{ kind: "sign", path: "/candidate/Quarterdeck.app" }]);
	});

	it("rejects invalid local signatures before inspecting or launching bundled code", async () => {
		state.failure = true;
		await expect(verifyApp("/candidate/Quarterdeck.app")).rejects.toThrow("Invalid signature");
		expect(state.events).toEqual([{ kind: "verify", path: "/candidate/Quarterdeck.app" }]);
	});
});
