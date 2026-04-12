import { showAppToast } from "@/components/app-toaster";

export const CONTEXT_MENU_ITEM_CLASS =
	"flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3";

export function copyToClipboard(text: string, label: string): void {
	void navigator.clipboard.writeText(text).then(
		() => showAppToast({ intent: "success", message: `${label} copied to clipboard` }),
		() => showAppToast({ intent: "danger", message: `Failed to copy ${label.toLowerCase()}` }),
	);
}
