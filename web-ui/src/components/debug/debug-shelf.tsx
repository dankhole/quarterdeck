import type { ReactElement } from "react";

import { DebugDialog } from "@/components/debug/debug-dialog";
import { DebugLogPanel } from "@/components/debug/debug-log-panel";
import { useDialogContext } from "@/providers/dialog-provider";

/**
 * Renders the debug log panel and debug dialog, reading all state from
 * DialogContext. Extracted from App.tsx to reduce its JSX surface.
 */
export function DebugShelf(): ReactElement | null {
	const { debugLogging, isDebugDialogOpen, handleShowStartupOnboardingDialog, handleDebugDialogOpenChange } =
		useDialogContext();

	return (
		<>
			{debugLogging.isDebugLogPanelOpen ? (
				<DebugLogPanel
					entries={debugLogging.filteredEntries}
					entryCount={debugLogging.entryCount}
					logLevel={debugLogging.logLevel}
					levelFilter={debugLogging.levelFilter}
					sourceFilter={debugLogging.sourceFilter}
					searchText={debugLogging.searchText}
					showConsoleCapture={debugLogging.showConsoleCapture}
					availableTags={debugLogging.availableTags}
					disabledTags={debugLogging.disabledTags}
					onSetLogLevel={debugLogging.setLogLevel}
					onSetLevelFilter={debugLogging.setLevelFilter}
					onSetSourceFilter={debugLogging.setSourceFilter}
					onSetSearchText={debugLogging.setSearchText}
					onSetShowConsoleCapture={debugLogging.setShowConsoleCapture}
					onToggleTag={debugLogging.toggleTag}
					onEnableAllTags={debugLogging.enableAllTags}
					onDisableAllTags={debugLogging.disableAllTags}
					onClear={debugLogging.clearLogEntries}
					onClose={debugLogging.closeDebugLogPanel}
				/>
			) : null}
			<DebugDialog
				open={isDebugDialogOpen}
				onOpenChange={handleDebugDialogOpenChange}
				onShowStartupOnboardingDialog={handleShowStartupOnboardingDialog}
			/>
		</>
	);
}
