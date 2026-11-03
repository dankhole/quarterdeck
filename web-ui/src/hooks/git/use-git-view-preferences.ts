import type { RuntimeGitViewPreference } from "@runtime-contract";
import { useCallback, useMemo, useState } from "react";
import type { GitViewTab } from "@/hooks/git/git-view";
import { sharedUiPreferences } from "@/storage/shared-ui-preferences";

export interface UseGitViewPreferencesResult {
	activeTab: GitViewTab;
	setActiveTab: (tab: GitViewTab) => void;
	collapsedDirectories: ReadonlySet<string>;
	setCollapsedDirectories: (directories: ReadonlySet<string>) => void;
}

/** Saved preferences seed each visit; another window never retargets this review. */
export function useGitViewPreferences(scope: string): UseGitViewPreferencesResult {
	const restored = useMemo(() => sharedUiPreferences.readGitView(scope), [scope]);
	const [state, setState] = useState({ scope, preference: restored });
	const preference = state.scope === scope ? state.preference : restored;
	const update = useCallback(
		(patch: RuntimeGitViewPreference) => {
			setState((previous) => ({
				scope,
				preference: { ...(previous.scope === scope ? previous.preference : restored), ...patch },
			}));
			sharedUiPreferences.writeGitView(scope, patch);
		},
		[scope, restored],
	);
	const setActiveTab = useCallback((tab: GitViewTab) => update({ activeTab: tab }), [update]);
	const collapsedDirectories = useMemo(
		() => new Set(preference.collapsedDirectories ?? []),
		[preference.collapsedDirectories],
	);
	const setCollapsedDirectories = useCallback(
		(directories: ReadonlySet<string>) => update({ collapsedDirectories: [...directories] }),
		[update],
	);
	return {
		activeTab: preference.activeTab ?? "uncommitted",
		setActiveTab,
		collapsedDirectories,
		setCollapsedDirectories,
	};
}
