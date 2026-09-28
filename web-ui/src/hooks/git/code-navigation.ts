import type { FileEditorTab } from "@/hooks/git/file-editor-workspace";
import type { WorkdirSearchScope } from "@/hooks/search/search-scope";
import type { CodeNavigationLocation, RuntimeConfigResponse } from "@/runtime/types";

export type CodeNavigationOperation = "definition" | "references" | "hover";
export type CodeNavigationConfig = Pick<RuntimeConfigResponse, "codeNavigationEnabled" | "lspServers">;

export const CODE_NAVIGATION_LABELS: Record<CodeNavigationOperation, string> = {
	definition: "Go to Definition",
	references: "Find References",
	hover: "Show Type Information",
};

export type CodeNavigationResult =
	| { status: "busy"; operation: CodeNavigationOperation }
	| { status: "unavailable" | "error"; operation: CodeNavigationOperation; message: string }
	| {
			status: "locations";
			operation: CodeNavigationOperation;
			sourcePath: string;
			locations: CodeNavigationLocation[];
			truncated: boolean;
	  }
	| { status: "hover"; operation: "hover"; contents: string };

export function codeNavigationUnavailableReason(input: {
	projectId: string | null;
	scope: WorkdirSearchScope;
	config: CodeNavigationConfig | null;
	tab: FileEditorTab | null;
	readOnly: boolean;
}): string | null {
	if (!input.projectId) return "Select a project to use code navigation.";
	if (input.scope.ref || input.readOnly)
		return "Code navigation is available in live workspaces. Open the worktree file to continue.";
	if (!input.config?.codeNavigationEnabled)
		return "Enable Code Navigation in Settings and configure an installed language server.";
	if (!input.tab || input.tab.binary || input.tab.truncated || !input.tab.editable)
		return "Code navigation requires a complete text file within the editor size limit.";
	const path = input.tab.path.toLowerCase();
	if (
		!input.config.lspServers.some(
			(server) => server.enabled && server.extensions.some((extension) => path.endsWith(extension.toLowerCase())),
		)
	) {
		return "No enabled language server matches this file. Add or enable one in Settings → Code Navigation.";
	}
	return null;
}

export function groupCodeNavigationLocations(
	locations: readonly CodeNavigationLocation[],
): Map<string, CodeNavigationLocation[]> {
	const groups = new Map<string, CodeNavigationLocation[]>();
	for (const location of locations) {
		const group = groups.get(location.path);
		if (group) group.push(location);
		else groups.set(location.path, [location]);
	}
	return groups;
}
