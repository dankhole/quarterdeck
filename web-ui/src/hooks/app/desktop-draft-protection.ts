const drafts = new Map<symbol, { label: string; isDirty: () => boolean }>();

/** Draft contents stay inside their editor; preflight reads only current dirty metadata. */
export function registerDesktopDraftProtection(label: string, isDirty: () => boolean): () => void {
	const identity = Symbol(label);
	drafts.set(identity, { label, isDirty });
	return () => {
		drafts.delete(identity);
	};
}

export function getDesktopProtectedDraftLabels(): string[] {
	return [...drafts.values()].filter((draft) => draft.isDirty()).map((draft) => draft.label);
}
