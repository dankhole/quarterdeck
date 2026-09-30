import { createContext, useContext } from "react";
import type { UseProjectManagementResult } from "@/hooks/project/use-project-management";

export const ProjectManagementContext = createContext<UseProjectManagementResult | null>(null);

export function useProjectManagementContext(): UseProjectManagementResult {
	const context = useContext(ProjectManagementContext);
	if (!context) throw new Error("useProjectManagementContext must be used within ProjectProvider");
	return context;
}
