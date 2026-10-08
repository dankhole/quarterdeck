import { join } from "node:path";

import { mergeProcessEnvironment } from "./process-environment.mjs";

/** Share only package downloads; installation, config, state and lifecycle policy stay isolated. */
export function createPackageSmokeEnvironment(base, smokeRoot, cacheDirectory) {
	const env = { ...base };
	for (const key of Object.keys(env)) {
		if (/^(npm_config_(?:cache|ignore_scripts|allow_scripts|dangerously_allow_all_scripts|strict_allow_scripts|userconfig|globalconfig)|NODE_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/iu.test(key)) {
			delete env[key];
		}
	}
	const stateRoot = join(smokeRoot, "state");
	return mergeProcessEnvironment(env, {
		HOME: stateRoot,
		USERPROFILE: stateRoot,
		QUARTERDECK_STATE_HOME: join(stateRoot, ".quarterdeck"),
		npm_config_cache: cacheDirectory ?? join(smokeRoot, "npm-cache"),
		npm_config_userconfig: join(smokeRoot, "user.npmrc"),
		npm_config_globalconfig: join(smokeRoot, "global.npmrc"),
	});
}
