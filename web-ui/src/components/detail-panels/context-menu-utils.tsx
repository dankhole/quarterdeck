import * as ContextMenu from "@radix-ui/react-context-menu";
import { ClipboardCopy, FileSearch } from "lucide-react";
import { showAppToast } from "@/components/app-toaster";
import type { FileNavigation } from "@/hooks/git/use-git-navigation";

export const CONTEXT_MENU_ITEM_CLASS =
	"flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3";

const CONTEXT_MENU_CONTENT_CLASS =
	"z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg";

export function copyToClipboard(text: string, label: string): void {
	void navigator.clipboard.writeText(text).then(
		() => showAppToast({ intent: "success", message: `${label} copied to clipboard` }),
		() => showAppToast({ intent: "danger", message: `Failed to copy ${label.toLowerCase()}` }),
	);
}

/**
 * Standard context menu items for file entries: optional "Show in File Browser" navigation,
 * then Copy name / Copy path, and optional extra items rendered via `children`.
 */
export function FileContextMenuItems({
	fileName,
	filePath,
	navigateToFile,
	children,
}: {
	fileName: string;
	filePath: string;
	navigateToFile?: (nav: FileNavigation) => void;
	/** Extra items rendered after Copy path (e.g. "Copy file contents"). */
	children?: React.ReactNode;
}): React.ReactElement {
	return (
		<ContextMenu.Content className={CONTEXT_MENU_CONTENT_CLASS}>
			{navigateToFile ? (
				<>
					<ContextMenu.Item
						className={CONTEXT_MENU_ITEM_CLASS}
						onSelect={() => navigateToFile({ targetView: "files", filePath })}
					>
						<FileSearch size={14} className="text-text-secondary" />
						Show in File Browser
					</ContextMenu.Item>
					<ContextMenu.Separator className="h-px bg-border my-1" />
				</>
			) : null}
			<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => copyToClipboard(fileName, "Name")}>
				<ClipboardCopy size={14} className="text-text-secondary" />
				Copy name
			</ContextMenu.Item>
			<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => copyToClipboard(filePath, "Path")}>
				<ClipboardCopy size={14} className="text-text-secondary" />
				Copy path
			</ContextMenu.Item>
			{children}
		</ContextMenu.Content>
	);
}
