import { useState } from "react";
import { LocalStorageKey } from "@/storage/local-storage-store";

// Each open tab keeps its own choices; storage seeds subsequent visits only.
const tabCollapsedGroups = new Map<string, string[]>();
function readCollapsed(scope: string): string[] {
	const cached = tabCollapsedGroups.get(scope);
	if (cached) return cached;
	let value: string[] = [];
	try {
		const parsed: unknown = JSON.parse(
			localStorage.getItem(`${LocalStorageKey.ProjectGroupsCollapsed}.${scope}`) ?? "[]",
		);
		if (Array.isArray(parsed)) value = parsed.filter((id): id is string => typeof id === "string");
	} catch {
		/* Storage is optional for presentation. */
	}
	tabCollapsedGroups.set(scope, value);
	return value;
}
export function useProjectGroupCollapse(scope: string) {
	const [, render] = useState(0);
	const collapsed = readCollapsed(scope);
	function setCollapsed(ids: string[]) {
		tabCollapsedGroups.set(scope, ids);
		try {
			localStorage.setItem(`${LocalStorageKey.ProjectGroupsCollapsed}.${scope}`, JSON.stringify(ids));
		} catch {
			/* Keep in-tab preference. */
		}
		render((value) => value + 1);
	}
	return {
		collapsed,
		setCollapsed,
		expand: (id: string) => setCollapsed(collapsed.filter((candidate) => candidate !== id)),
		toggle: (id: string) =>
			setCollapsed(collapsed.includes(id) ? collapsed.filter((candidate) => candidate !== id) : [...collapsed, id]),
	};
}
