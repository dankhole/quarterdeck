import { toast } from "sonner";

export const CONTEXT_MENU_ITEM_CLASS =
	"flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3";

export function copyToClipboard(text: string, label: string): void {
	void navigator.clipboard.writeText(text).then(
		() => toast.success(`${label} copied to clipboard`),
		() => toast.error(`Failed to copy ${label.toLowerCase()}`),
	);
}
