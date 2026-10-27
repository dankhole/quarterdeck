import { useCallback, useRef, useState } from "react";
import type { SourceEditorAction, SourceEditorActionContext } from "@/components/editor/source-editor-context";
import type { WorkdirSearchScope } from "@/hooks/search/search-scope";
import { CODE_NAVIGATION_LABELS, type CodeNavigationConfig, type CodeNavigationResult } from "./code-navigation";
import { diffCodeNavigationUnavailableReason } from "./diff-code-navigation";
import type { ReviewDocument } from "./review-document";
import { useCodeNavigation } from "./use-code-navigation";

export interface DiffCodeNavigationOptions {
	projectId: string | null;
	scope: WorkdirSearchScope;
	config: CodeNavigationConfig | null;
}

export interface DiffCodeNavigationTarget {
	context: SourceEditorActionContext | null;
	unavailableReason: string | null;
}

export interface UseDiffCodeNavigationResult {
	actions: readonly SourceEditorAction[];
	result: CodeNavigationResult | null;
	documentVersion: number;
	dismiss: () => void;
	select: (action: SourceEditorAction, target: DiffCodeNavigationTarget) => void;
}

/** Reuses Files' request/results owner; this adapter grants navigation, never editing or saving. */
export function useDiffCodeNavigation(
	document: ReviewDocument,
	options: DiffCodeNavigationOptions,
): UseDiffCodeNavigationResult {
	const content = document.content.kind === "text" ? document.content.newText : null;
	const identity = JSON.stringify([
		document.key,
		options.projectId,
		options.scope,
		options.config?.codeNavigationEnabled,
		options.config?.lspServers,
	]);
	const oldContent = document.content.kind === "text" ? document.content.oldText : null;
	const source = useRef({ identity, content, oldContent, version: 1 });
	if (
		source.current.identity !== identity ||
		source.current.content !== content ||
		source.current.oldContent !== oldContent
	) {
		source.current = { identity, content, oldContent, version: source.current.version + 1 };
	}
	const documentVersion = source.current.version;
	const scopeKey = `${document.key}:${documentVersion}`;
	const sourceUnavailableReason = diffCodeNavigationUnavailableReason(document);
	const shared = useCodeNavigation({
		...options,
		scopeKey,
		source:
			content !== null && document.newPath
				? {
						path: document.newPath,
						content,
						eligibility: sourceUnavailableReason === null ? "eligible" : "read-only",
					}
				: null,
	});
	const [denied, setDenied] = useState<{ version: number; result: CodeNavigationResult } | null>(null);
	const dismiss = useCallback(() => {
		setDenied(null);
		shared.dismiss();
	}, [shared.dismiss]);
	const select = useCallback(
		(action: SourceEditorAction, target: DiffCodeNavigationTarget) => {
			// A context menu may stay open while its source is refreshed or re-scoped.
			if (target.context && target.context.documentVersion !== documentVersion) return;
			const message = sourceUnavailableReason ?? target.unavailableReason;
			if (message || !target.context) {
				shared.dismiss();
				const operation = (Object.keys(CODE_NAVIGATION_LABELS) as Array<keyof typeof CODE_NAVIGATION_LABELS>).find(
					(key) => action.id === `code-navigation-${key}`,
				);
				if (operation)
					setDenied({
						version: documentVersion,
						result: {
							status: "unavailable",
							operation,
							message: message ?? "Right-click a symbol in the diff text to choose its position.",
						},
					});
				return;
			}
			setDenied(null);
			action.onSelect(target.context);
		},
		[sourceUnavailableReason, documentVersion, shared.dismiss],
	);
	return {
		actions: shared.actions,
		result: denied?.version === documentVersion ? denied.result : shared.result,
		documentVersion,
		dismiss,
		select,
	};
}
