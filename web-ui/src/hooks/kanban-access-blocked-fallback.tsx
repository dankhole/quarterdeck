import { ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";

export function KanbanAccessBlockedFallback(): ReactElement {
	return (
		<div className="flex h-[100svh] items-center justify-center bg-surface-0 p-6">
			<div className="flex max-w-2xl flex-col items-center gap-3 text-center">
				<ShieldAlert size={48} className="text-status-orange" />
				<h3 className="text-base font-semibold text-text-primary">Kanban is not enabled for your organization</h3>
				<p className="text-sm text-text-secondary">
					Your admin needs to enable Kanban in remote config before you can use it.
				</p>
				<p className="text-sm text-text-secondary">
					Kanban is currently in beta and still needs additional enterprise security guardrails.
				</p>
			</div>
		</div>
	);
}
