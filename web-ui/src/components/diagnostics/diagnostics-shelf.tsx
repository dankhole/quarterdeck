import type { ReactElement } from "react";

import { DebugDialog } from "@/components/debug/debug-dialog";
import { DiagnosticsPanel } from "@/components/diagnostics/diagnostics-panel";
import { useDialogContext } from "@/providers/dialog-provider";

export function DiagnosticsShelf(): ReactElement {
	const { diagnostics, isDebugDialogOpen, handleShowStartupOnboardingDialog, handleDebugDialogOpenChange } =
		useDialogContext();
	return (
		<>
			{diagnostics.isPanelOpen ? <DiagnosticsPanel diagnostics={diagnostics} /> : null}
			<DebugDialog
				open={isDebugDialogOpen}
				onOpenChange={handleDebugDialogOpenChange}
				onShowStartupOnboardingDialog={handleShowStartupOnboardingDialog}
			/>
		</>
	);
}
