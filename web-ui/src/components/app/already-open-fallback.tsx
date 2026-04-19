import { AppWindow } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";

interface AlreadyOpenFallbackProps {
	onForceOpen: () => void;
}

export function AlreadyOpenFallback({ onForceOpen }: AlreadyOpenFallbackProps): ReactElement {
	return (
		<div className="min-h-screen bg-surface-0 text-text-primary flex items-center justify-center p-6">
			<div className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
				<div className="flex items-center gap-3 text-text-primary">
					<div className="flex h-10 w-10 items-center justify-center rounded-lg border border-text-tertiary/30 bg-text-tertiary/10 text-text-tertiary">
						<AppWindow size={18} />
					</div>
					<div>
						<h1 className="text-lg font-semibold">Quarterdeck is open in another tab</h1>
						<p className="mt-1 text-sm text-text-secondary">
							Only one tab can be active at a time to prevent conflicts with terminal sessions and board state.
						</p>
					</div>
				</div>
				<div className="mt-5">
					<Button size="md" variant="primary" onClick={onForceOpen}>
						Use here instead
					</Button>
				</div>
			</div>
		</div>
	);
}
