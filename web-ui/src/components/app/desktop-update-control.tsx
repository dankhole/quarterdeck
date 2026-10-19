import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDesktopUpdate } from "@/hooks/app/use-desktop-update";

export function DesktopUpdateControl(): React.ReactElement | null {
	const { availableVersion, showDetails } = useDesktopUpdate();
	if (!availableVersion) return null;
	return (
		<Button
			variant="ghost"
			size="sm"
			icon={<Download size={14} aria-hidden="true" />}
			onClick={showDetails}
			className="ml-1 text-status-blue whitespace-nowrap"
		>
			Update available · v{availableVersion}
		</Button>
	);
}
