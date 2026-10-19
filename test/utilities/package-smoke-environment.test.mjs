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
	it("isolates runtime launch, native admission, provider context, and desktop install mode", () => {
		const base = {
			PATH: "/external/bin",
			QUARTERDECK_INSTALLATION_LOCK_FD: "99",
			QUARTERDECK_INSTALLATION_LOCK_PATH: "/active/installation/admission.lock",
			QUARTERDECK_DESKTOP_CHILD: "1",
			QUARTERDECK_RUNTIME_HOST: "127.0.0.1",
			QUARTERDECK_RUNTIME_PORT: "12345",
			QUARTERDECK_HOOK_PROJECT_ID: "synthetic-project",
			QUARTERDECK_HOOK_TASK_ID: "synthetic-task",
			QUARTERDECK_HOOK_SESSION_INSTANCE_ID: "synthetic-session",
			QUARTERDECK_INSTALL_MODE: "desktop",
			quarterdeck_state_home: "/other-active-state",
		};
		const env = createPackageSmokeEnvironment(base, "/fixture");
		expect(Object.keys(env).filter((key) => /^QUARTERDECK_/iu.test(key))).toEqual(["QUARTERDECK_STATE_HOME"]);
		expect(env.QUARTERDECK_STATE_HOME).toBe(join("/fixture", "state", ".quarterdeck"));
		expect(env.PATH).toBe(base.PATH);
		expect(base.QUARTERDECK_INSTALLATION_LOCK_FD).toBe("99");
	});
});
