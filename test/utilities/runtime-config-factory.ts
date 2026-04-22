import { DEFAULT_RUNTIME_CONFIG_STATE, type RuntimeConfigState } from "../../src/config";

type RuntimeConfigFixtureShape = Pick<
	RuntimeConfigState,
	| "audibleNotificationEvents"
	| "audibleNotificationSuppressCurrentProject"
	| "shortcuts"
	| "pinnedBranches"
	| "promptShortcuts"
	| "hiddenDefaultPromptShortcuts"
>;

type RuntimeConfigFixtureOverrides<T extends RuntimeConfigFixtureShape> = Omit<
	Partial<T>,
	| "audibleNotificationEvents"
	| "audibleNotificationSuppressCurrentProject"
	| "shortcuts"
	| "pinnedBranches"
	| "promptShortcuts"
	| "hiddenDefaultPromptShortcuts"
> & {
	audibleNotificationEvents?: Partial<T["audibleNotificationEvents"]>;
	audibleNotificationSuppressCurrentProject?: Partial<T["audibleNotificationSuppressCurrentProject"]>;
	shortcuts?: T["shortcuts"];
	pinnedBranches?: T["pinnedBranches"];
	promptShortcuts?: T["promptShortcuts"];
	hiddenDefaultPromptShortcuts?: T["hiddenDefaultPromptShortcuts"];
};

export type TestRuntimeConfigSaveRequest = Omit<
	RuntimeConfigState,
	| "globalConfigPath"
	| "projectConfigPath"
	| "commitPromptTemplateDefault"
	| "openPrPromptTemplateDefault"
	| "worktreeSystemPromptTemplateDefault"
>;

function cloneShortcuts(shortcuts: RuntimeConfigState["shortcuts"]): RuntimeConfigState["shortcuts"] {
	return shortcuts.map((shortcut) => ({ ...shortcut }));
}

function clonePromptShortcuts(
	promptShortcuts: RuntimeConfigState["promptShortcuts"],
): RuntimeConfigState["promptShortcuts"] {
	return promptShortcuts.map((shortcut) => ({ ...shortcut }));
}

function buildRuntimeConfigFixture<T extends RuntimeConfigFixtureShape>(
	base: T,
	overrides: RuntimeConfigFixtureOverrides<T>,
): T {
	return {
		...base,
		...overrides,
		audibleNotificationEvents: {
			...base.audibleNotificationEvents,
			...overrides.audibleNotificationEvents,
		},
		audibleNotificationSuppressCurrentProject: {
			...base.audibleNotificationSuppressCurrentProject,
			...overrides.audibleNotificationSuppressCurrentProject,
		},
		shortcuts: overrides.shortcuts ? cloneShortcuts(overrides.shortcuts) : cloneShortcuts(base.shortcuts),
		pinnedBranches: overrides.pinnedBranches ? [...overrides.pinnedBranches] : [...base.pinnedBranches],
		promptShortcuts: overrides.promptShortcuts
			? clonePromptShortcuts(overrides.promptShortcuts)
			: clonePromptShortcuts(base.promptShortcuts),
		hiddenDefaultPromptShortcuts: overrides.hiddenDefaultPromptShortcuts
			? [...overrides.hiddenDefaultPromptShortcuts]
			: [...base.hiddenDefaultPromptShortcuts],
	};
}

function createDefaultRuntimeConfigBase(): RuntimeConfigState {
	return {
		...DEFAULT_RUNTIME_CONFIG_STATE,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		audibleNotificationEvents: { ...DEFAULT_RUNTIME_CONFIG_STATE.audibleNotificationEvents },
		audibleNotificationSuppressCurrentProject: {
			...DEFAULT_RUNTIME_CONFIG_STATE.audibleNotificationSuppressCurrentProject,
		},
		shortcuts: cloneShortcuts(DEFAULT_RUNTIME_CONFIG_STATE.shortcuts),
		pinnedBranches: [...DEFAULT_RUNTIME_CONFIG_STATE.pinnedBranches],
		promptShortcuts: clonePromptShortcuts(DEFAULT_RUNTIME_CONFIG_STATE.promptShortcuts),
		hiddenDefaultPromptShortcuts: [...DEFAULT_RUNTIME_CONFIG_STATE.hiddenDefaultPromptShortcuts],
	};
}

export function createDefaultMockConfig(
	overrides: RuntimeConfigFixtureOverrides<RuntimeConfigState> = {},
): RuntimeConfigState {
	return buildRuntimeConfigFixture(createDefaultRuntimeConfigBase(), overrides);
}

export const createTestRuntimeConfigState = createDefaultMockConfig;

export function createDefaultRuntimeConfigSaveRequest(
	overrides: RuntimeConfigFixtureOverrides<TestRuntimeConfigSaveRequest> = {},
): TestRuntimeConfigSaveRequest {
	const {
		globalConfigPath: _globalConfigPath,
		projectConfigPath: _projectConfigPath,
		commitPromptTemplateDefault: _commitPromptTemplateDefault,
		openPrPromptTemplateDefault: _openPrPromptTemplateDefault,
		worktreeSystemPromptTemplateDefault: _worktreeSystemPromptTemplateDefault,
		...base
	} = createDefaultRuntimeConfigBase();

	return buildRuntimeConfigFixture(base, overrides);
}
