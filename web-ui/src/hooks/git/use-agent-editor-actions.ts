import { useMemo } from "react";
import { showAppToast } from "@/components/app-toaster";
import type { SourceEditorAction, SourceEditorActionContext } from "@/components/editor/source-editor-context";
import { useTaskAgentContext } from "@/providers/task-agent-context-provider";
import { captureEditorAgentContext } from "./agent-context";

export function useAgentEditorActions(): readonly SourceEditorAction[] {
	const agentContext = useTaskAgentContext();
	return useMemo(() => {
		if (!agentContext) return [];
		return (["selection", "file"] as const).map((kind) => ({
			id: `ask-agent-${kind}`,
			label: kind === "selection" ? "Ask agent about selection…" : "Ask agent about file…",
			onSelect: (editorContext: SourceEditorActionContext) => {
				const context = captureEditorAgentContext(editorContext, kind);
				if (context) agentContext.openContext(context);
				else showAppToast({ intent: "warning", message: "Select text in the editor first." });
			},
		}));
	}, [agentContext]);
}
