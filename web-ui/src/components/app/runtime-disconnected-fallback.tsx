import { RefreshCw, Unplug } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";

export function RuntimeDisconnectedFallback(): ReactElement {
	return (
		<div className="min-h-screen bg-surface-0 text-text-primary flex items-center justify-center p-6">
			<div className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
				<div className="flex items-center gap-3 text-text-primary">
					<div className="flex h-10 w-10 items-center justify-center rounded-lg border border-text-tertiary/30 bg-text-tertiary/10 text-text-tertiary">
						<Unplug size={18} />
					</div>
					<div>
						<h1 className="text-lg font-semibold">Disconnected from Quarterdeck</h1>
						<p className="mt-1 text-sm text-text-secondary">
							The server is no longer running. Start it again in your terminal, then reload.
						</p>
					</div>
				</div>
				<div className="mt-5">
					<Button
						size="md"
						variant="primary"
						icon={<RefreshCw size={16} />}
						onClick={() => {
							window.location.reload();
						}}
					>
						Reload page
					</Button>
				</div>
			</div>
		</div>
	);
}
