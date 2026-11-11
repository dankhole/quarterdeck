/** Split canonical branch names without changing remote namespaces or selection values. */
export function getBranchFolderPath(branchName: string): readonly string[] {
	return branchName.split("/");
}

/** Shared sizing for branch menus, independent of their trigger's compact layout. */
export const BRANCH_DROPDOWN_CLASS_NAME =
	"w-[max(30rem,var(--radix-popover-trigger-width))] max-w-[var(--radix-popover-content-available-width)]";

/** Allow even unbroken branch names to fit inside the viewport. */
export const BRANCH_TOOLTIP_CLASS_NAME = "block max-w-[min(40rem,calc(100vw-2rem))] break-all whitespace-normal";
