import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import { type FileNavigation, useGitNavigation } from "@/hooks/git/use-git-navigation";
import type { GitViewCompareNavigation } from "@/hooks/git/use-git-view-compare";
import { DEFAULT_WORKDIR_SEARCH_SCOPE, type WorkdirSearchScope } from "@/hooks/search/search-scope";
import { useBoardContext } from "@/providers/board-provider";
import { useProjectNavigationContext } from "@/providers/project-provider";
import { type MainViewId, type SidebarId, useCardDetailLayout } from "@/resize/use-card-detail-layout";

export interface SurfaceNavigationContextValue {
	isGitHistoryOpen: boolean;
	handleToggleGitHistory: () => void;
	openGitHistory: () => void;
	closeGitHistory: () => void;
	pendingCompareNavigation: GitViewCompareNavigation | null;
	pendingFileNavigation: FileNavigation | null;
	openGitCompare: (navigation: GitViewCompareNavigation) => void;
	clearPendingCompareNavigation: () => void;
	navigateToFile: (nav: FileNavigation) => void;
	clearPendingFileNavigation: () => void;
	navigateToGitView: () => void;
	activeFileSearchScope: WorkdirSearchScope;
	setActiveFileSearchScope: (scope: WorkdirSearchScope) => void;
	mainView: MainViewId;
	sidebar: SidebarId | null;
	setMainView: (view: MainViewId, callbacks?: { setSelectedTaskId?: (id: string | null) => void }) => void;
	toggleSidebar: (id: SidebarId) => void;
	visualMainView: MainViewId;
	visualSidebar: SidebarId | null;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	resetSurfaceNavigationToDefaults: () => void;
}

export const SurfaceNavigationContext = createContext<SurfaceNavigationContextValue | null>(null);

export function useSurfaceNavigationContext(): SurfaceNavigationContextValue {
	const ctx = useContext(SurfaceNavigationContext);
	if (!ctx) {
		throw new Error("useSurfaceNavigationContext must be used within a SurfaceNavigationContext.Provider");
	}
	return ctx;
}

interface SurfaceNavigationProviderProps {
	children: ReactNode;
}

export function SurfaceNavigationProvider({ children }: SurfaceNavigationProviderProps): ReactNode {
	const { hasNoProjects, isProjectSwitching, projects, currentProjectId } = useProjectNavigationContext();
	const folderOnly = Boolean(projects?.find((project) => project.id === currentProjectId)?.folderOnly);
	const { selectedTaskId, setSelectedTaskId } = useBoardContext();
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	const [activeFileSearchScope, setActiveFileSearchScope] = useState<WorkdirSearchScope>(DEFAULT_WORKDIR_SEARCH_SCOPE);

	const {
		mainView,
		sidebar,
		setMainView,
		toggleSidebar,
		visualMainView,
		visualSidebar,
		sidePanelRatio,
		setSidePanelRatio,
		resetToDefaults: resetSurfaceNavigationToDefaults,
	} = useCardDetailLayout({ selectedTaskId, isProjectSwitching });

	const {
		pendingCompareNavigation,
		pendingFileNavigation,
		openGitCompare,
		clearPendingCompareNavigation,
		navigateToFile,
		clearPendingFileNavigation,
		navigateToGitView,
	} = useGitNavigation({ isGitHistoryOpen, setMainView, setSelectedTaskId });

	const handleToggleGitHistory = useCallback(() => {
		if (hasNoProjects || folderOnly) return;
		setIsGitHistoryOpen((current) => !current);
	}, [hasNoProjects, folderOnly]);

	const openGitHistory = useCallback(() => {
		if (hasNoProjects || folderOnly) return;
		setIsGitHistoryOpen(true);
	}, [hasNoProjects, folderOnly]);

	const closeGitHistory = useCallback(() => {
		setIsGitHistoryOpen(false);
	}, []);

	useLayoutEffect(() => {
		if (isProjectSwitching) {
			setIsGitHistoryOpen(false);
		}
	}, [isProjectSwitching]);

	const value = useMemo<SurfaceNavigationContextValue>(
		() => ({
			isGitHistoryOpen: !folderOnly && isGitHistoryOpen,
			handleToggleGitHistory,
			openGitHistory,
			closeGitHistory,
			pendingCompareNavigation,
			pendingFileNavigation,
			openGitCompare,
			clearPendingCompareNavigation,
			navigateToFile,
			clearPendingFileNavigation,
			navigateToGitView,
			activeFileSearchScope,
			setActiveFileSearchScope,
			mainView: folderOnly && mainView === "git" ? "home" : mainView,
			sidebar: folderOnly && sidebar === "commit" ? null : sidebar,
			setMainView,
			toggleSidebar,
			visualMainView: folderOnly && visualMainView === "git" ? "home" : visualMainView,
			visualSidebar: folderOnly && visualSidebar === "commit" ? null : visualSidebar,
			sidePanelRatio,
			setSidePanelRatio,
			resetSurfaceNavigationToDefaults,
		}),
		[
			folderOnly,
			isGitHistoryOpen,
			handleToggleGitHistory,
			openGitHistory,
			closeGitHistory,
			pendingCompareNavigation,
			pendingFileNavigation,
			openGitCompare,
			clearPendingCompareNavigation,
			navigateToFile,
			clearPendingFileNavigation,
			navigateToGitView,
			activeFileSearchScope,
			setActiveFileSearchScope,
			mainView,
			sidebar,
			setMainView,
			toggleSidebar,
			visualMainView,
			visualSidebar,
			sidePanelRatio,
			setSidePanelRatio,
			resetSurfaceNavigationToDefaults,
		],
	);

	return <SurfaceNavigationContext.Provider value={value}>{children}</SurfaceNavigationContext.Provider>;
}
