import { MessageSquare } from "lucide-react";
import type { UnifiedDiffRow } from "@/components/shared/diff-parser";
import { Button } from "@/components/ui/button";
import { captureDiffAgentContext } from "@/hooks/git/agent-context";
import { useTaskAgentContext } from "@/providers/task-agent-context-provider";

export function AgentDiffHunkAction({
	path,
	rows,
	source,
}: {
	path: string;
	rows: readonly UnifiedDiffRow[];
	source?: string;
}): React.ReactElement | null {
	const agentContext = useTaskAgentContext();
	if (!agentContext || !rows.some((row) => row.variant !== "context")) return null;
	return (
		<div className="flex justify-end border-b border-border bg-surface-1 px-2 py-1">
			<Button
				variant="ghost"
				size="sm"
				icon={<MessageSquare size={12} />}
				onClick={() => {
					const context = captureDiffAgentContext(path, rows);
					if (context) agentContext.openContext({ ...context, ...(source ? { source } : {}) });
				}}
			>
				Ask agent about hunk…
			</Button>
		</div>
	);
}
