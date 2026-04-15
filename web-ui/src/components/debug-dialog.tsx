import { Bug } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";

export function DebugDialog({
	open,
	onOpenChange,
	onShowStartupOnboardingDialog,
}: {
	open: boolean;
	onOpenChange: (nextOpen: boolean) => void;
	onShowStartupOnboardingDialog: () => void;
}): ReactElement {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogHeader title="Debug tools" icon={<Bug size={16} />} />
			<DialogBody className="space-y-4">
				<div className="rounded-md border border-border bg-surface-2 p-3">
					<p className="text-sm font-medium text-text-primary">Show onboarding dialog</p>
					<p className="mt-1 text-xs text-text-secondary">
						Reopen the startup onboarding dialog so you can verify onboarding flows.
					</p>
					<Button variant="default" size="sm" onClick={onShowStartupOnboardingDialog} className="mt-3">
						Show onboarding
					</Button>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="default" onClick={() => onOpenChange(false)}>
					Close
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
