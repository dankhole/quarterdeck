import { DEFAULT_RUNTIME_CONFIG_STATE, type RuntimeConfigState } from "../../src/config";

export function createTestRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		...DEFAULT_RUNTIME_CONFIG_STATE,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		...overrides,
	};
}
