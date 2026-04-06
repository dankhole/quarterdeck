interface UseKanbanAccessGateInput {
	workspaceId: string | null;
}

export function useKanbanAccessGate(_input: UseKanbanAccessGateInput): { isBlocked: boolean } {
	// Without Cline SDK, Kanban access is always unrestricted.
	return { isBlocked: false };
}
