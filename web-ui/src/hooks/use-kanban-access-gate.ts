interface UseKanbanAccessGateInput {
	workspaceId: string | null;
}

export function useKanbanAccessGate(_input: UseKanbanAccessGateInput): { isBlocked: boolean } {
	// Kanban access is always unrestricted.
	return { isBlocked: false };
}
