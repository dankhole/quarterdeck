import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPackageSmokeEnvironment } from "../../scripts/package-smoke-environment.mjs";

describe("package smoke download cache", () => {
	it("keeps cold isolated caching by default", () => {
		const env = createPackageSmokeEnvironment({ npm_config_cache: "/host-cache", NPM_CONFIG_CACHE: "/other-cache" }, "/fixture");
		expect(env.npm_config_cache).toBe(join("/fixture", "npm-cache"));
		expect(env.NPM_CONFIG_CACHE).toBeUndefined();
	});
	it("shares downloads without inheriting lifecycle overrides or user state", () => {
		const base = {
			npm_config_ignore_scripts: "true", NPM_CONFIG_ALLOW_SCRIPTS: "all",
			npm_config_dangerously_allow_all_scripts: "true", npm_config_strict_allow_scripts: "false",
			NODE_OPTIONS: "--require /host-hook", NODE_PATH: "/host-modules", ELECTRON_RUN_AS_NODE: "1",
			HOME: "/host", QUARTERDECK_STATE_HOME: "/active", npm_config_userconfig: "/host-config",
		};
		const env = createPackageSmokeEnvironment(base, "/fixture", "/downloads");
		expect(env).toEqual({
			HOME: join("/fixture", "state"), USERPROFILE: join("/fixture", "state"),
			QUARTERDECK_STATE_HOME: join("/fixture", "state", ".quarterdeck"),
			npm_config_cache: "/downloads", npm_config_userconfig: join("/fixture", "user.npmrc"),
			npm_config_globalconfig: join("/fixture", "global.npmrc"),
		});
		expect(base.HOME).toBe("/host");
	});
});
