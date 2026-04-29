import * as ContextMenu from "@radix-ui/react-context-menu";
import { ClipboardCopy, FileSearch } from "lucide-react";
import { showAppToast } from "@/components/app-toaster";
import type { FileNavigation } from "@/hooks/git/use-git-navigation";

export const CONTEXT_MENU_ITEM_CLASS =
	"flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3";

const CONTEXT_MENU_CONTENT_CLASS =
	"z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg";

function copyViaTextArea(text: string): boolean {
	if (typeof document.execCommand !== "function") {
		return false;
	}
	const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const selection = document.getSelection();
	const selectedRanges =
		selection != null
			? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
			: [];
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.readOnly = true;
	textarea.style.position = "fixed";
	textarea.style.top = "-1000px";
	textarea.style.left = "-1000px";
	textarea.style.opacity = "0";
	textarea.style.pointerEvents = "none";
	document.body.appendChild(textarea);
	let copied = false;
	try {
		textarea.select();
		copied = document.execCommand("copy");
	} finally {
		document.body.removeChild(textarea);
		activeElement?.focus({ preventScroll: true });
		if (selection != null) {
			selection.removeAllRanges();
			for (const range of selectedRanges) {
				selection.addRange(range);
			}
		}
	}
	return copied;
}

export async function writeClipboardText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			if (copyViaTextArea(text)) {
				return;
			}
			throw new Error("Clipboard write failed");
		}
	}
	if (copyViaTextArea(text)) {
		return;
	}
	throw new Error("Clipboard API unavailable");
}

export function copyToClipboard(text: string, label: string): void {
	void writeClipboardText(text).then(
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
