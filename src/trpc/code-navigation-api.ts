import type { IRuntimeConfigProvider } from "../core";
import type {
	CodeNavigationHoverResponse,
	CodeNavigationRequest,
	CodeNavigationResponse,
	CodeNavigationScope,
	CodeNavigationStatus,
} from "../core/api/code-navigation";
import type { LanguageNavigationManager } from "../language-navigation/manager";
import type { RuntimeTrpcProjectScope } from "./app-router-context";
import { resolveProjectFileScope } from "./project-api-file-scopes";

export interface CodeNavigationApi {
	status(scope: RuntimeTrpcProjectScope, input: CodeNavigationScope): Promise<CodeNavigationStatus>;
	definition(scope: RuntimeTrpcProjectScope, input: CodeNavigationRequest): Promise<CodeNavigationResponse>;
	references(scope: RuntimeTrpcProjectScope, input: CodeNavigationRequest): Promise<CodeNavigationResponse>;
	hover(scope: RuntimeTrpcProjectScope, input: CodeNavigationRequest): Promise<CodeNavigationHoverResponse>;
}

export function createCodeNavigationApi(
	manager: LanguageNavigationManager,
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">,
): CodeNavigationApi {
	const resolveScope = async (scope: RuntimeTrpcProjectScope, input: CodeNavigationScope) => {
		const fileScope = await resolveProjectFileScope(scope.projectPath, input);
		return fileScope.cwd && fileScope.ref === null ? { projectId: scope.projectId, cwd: fileScope.cwd } : null;
	};
	const unavailable = {
		status: "unavailable" as const,
		message: "Code navigation is available only for live project or task files.",
	};
	const navigate = async (
		operation: "definition" | "references",
		scope: RuntimeTrpcProjectScope,
		input: CodeNavigationRequest,
	): Promise<CodeNavigationResponse> => {
		const generation = manager.generation;
		const fileScope = await resolveScope(scope, input);
		if (!fileScope) return { ...unavailable, documentVersion: input.documentVersion };
		return manager.navigate(operation, fileScope, await config.loadScopedRuntimeConfig(scope), input, generation);
	};
	return {
		status: async (scope, input) => {
			if (!(await resolveScope(scope, input))) return unavailable;
			return manager.status(await config.loadScopedRuntimeConfig(scope), input.path);
		},
		definition: (scope, input) => navigate("definition", scope, input),
		references: (scope, input) => navigate("references", scope, input),
		hover: async (scope, input) => {
			const generation = manager.generation;
			const fileScope = await resolveScope(scope, input);
			if (!fileScope) return { ...unavailable, documentVersion: input.documentVersion };
			return manager.hover(fileScope, await config.loadScopedRuntimeConfig(scope), input, generation);
		},
	};
}
