interface UseQuarterdeckAccessGateInput {
	projectId: string | null;
}

export function useQuarterdeckAccessGate(_input: UseQuarterdeckAccessGateInput): { isBlocked: boolean } {
	// Quarterdeck access is always unrestricted.
	return { isBlocked: false };
}
