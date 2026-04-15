import type { ReactNode } from "react";

import { BoardContext, type BoardContextValue } from "@/providers/board-provider";
import { DialogContext, type DialogContextValue } from "@/providers/dialog-provider";
import { GitContext, type GitContextValue } from "@/providers/git-provider";
import { InteractionsContext, type InteractionsContextValue } from "@/providers/interactions-provider";
import { ProjectContext, type ProjectContextValue } from "@/providers/project-provider";
import { TerminalContext, type TerminalContextValue } from "@/providers/terminal-provider";

export interface AppProvidersProps {
	project: ProjectContextValue;
	board: BoardContextValue;
	git: GitContextValue;
	terminal: TerminalContextValue;
	interactions: InteractionsContextValue;
	dialog: DialogContextValue;
	children: ReactNode;
}

/**
 * Composes all application-level context providers in the correct nesting
 * order. Outermost providers are available to inner ones:
 *
 *   Project → Board → Terminal → Git → Interactions → Dialog → children
 */
export function AppProviders({
	project,
	board,
	git,
	terminal,
	interactions,
	dialog,
	children,
}: AppProvidersProps): ReactNode {
	return (
		<ProjectContext.Provider value={project}>
			<BoardContext.Provider value={board}>
				<TerminalContext.Provider value={terminal}>
					<GitContext.Provider value={git}>
						<InteractionsContext.Provider value={interactions}>
							<DialogContext.Provider value={dialog}>{children}</DialogContext.Provider>
						</InteractionsContext.Provider>
					</GitContext.Provider>
				</TerminalContext.Provider>
			</BoardContext.Provider>
		</ProjectContext.Provider>
	);
}
