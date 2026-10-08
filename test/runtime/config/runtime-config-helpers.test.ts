import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../../utilities/temp-dir";
import { withTemporaryEnv } from "./runtime-config-helpers";

describe("withTemporaryEnv", { concurrent: false }, () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each(["success", "rejection", "synchronous throw"] as const)(
		"isolates inherited state and restores the environment after %s",
		async (outcome) => {
			const temp = createTempDir("quarterdeck-config-env-");
			const inheritedStateHome = join(temp.path, "inherited-state");
			vi.stubEnv("HOME", join(temp.path, "original-home"));
			vi.stubEnv("USERPROFILE", join(temp.path, "original-profile"));
			vi.stubEnv("PATH", join(temp.path, "original-bin"));
			vi.stubEnv("QUARTERDECK_STATE_HOME", inheritedStateHome);
			const originalEnvironment = { ...process.env };
			const failure = new Error("fixture failure");

			try {
				const result = withTemporaryEnv(
					{ home: temp.path, pathPrefix: join(temp.path, "bin"), replacePath: true },
					() => {
						expect(process.env.HOME).toBe(temp.path);
						expect(process.env.USERPROFILE).toBe(temp.path);
						expect(process.env.QUARTERDECK_STATE_HOME).toBe(join(temp.path, ".quarterdeck"));
						if (outcome === "synchronous throw") throw failure;
						return outcome === "rejection" ? Promise.reject(failure) : Promise.resolve("done");
					},
				);
				if (outcome === "success") await expect(result).resolves.toBe("done");
				else await expect(result).rejects.toBe(failure);
				expect(process.env).toEqual(originalEnvironment);
			} finally {
				temp.cleanup();
			}
		},
	);

	it("removes the state override when the caller did not have one", async () => {
		const temp = createTempDir("quarterdeck-config-env-");
		vi.stubEnv("QUARTERDECK_STATE_HOME", undefined);
		try {
			await withTemporaryEnv({ home: temp.path }, async () => {
				expect(process.env.QUARTERDECK_STATE_HOME).toBe(join(temp.path, ".quarterdeck"));
			});
			expect(process.env.QUARTERDECK_STATE_HOME).toBeUndefined();
		} finally {
			temp.cleanup();
		}
	});
});
